import { config } from 'dotenv';
config();

import { Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '../config/db';
import {
  conversationMessages,
  dailySummaries,
  userGlobalMemory,
  memoryConflicts,
} from '../config/schema';
import { eq, and, gte } from 'drizzle-orm';
import openai from '../config/openai';
import { index } from '../config/pinecone';

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

const workerConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

type GenerateJobData = {
  user_id: number;
  trigger_reason?: string;
};

async function processor(job: { data: GenerateJobData }) {
  const { user_id } = job.data;

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayStr = todayStart.toISOString().split('T')[0];

  const todayMessages = await db
    .select({ role: conversationMessages.role, content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.userId, user_id),
        gte(conversationMessages.createdAt, todayStart)
      )
    )
    .orderBy(conversationMessages.createdAt);

  const messagesText = todayMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n');
  if (!messagesText.trim()) return;

  const [globalRow] = await db
    .select()
    .from(userGlobalMemory)
    .where(eq(userGlobalMemory.userId, user_id))
    .limit(1);

  const namespace = `user_${user_id}`;

  const completion1 = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Summarize the events and key information in the following conversations from today. Output a concise paragraph and 3-5 bullet points. Under 300 words.',
      },
      { role: 'user', content: messagesText },
    ],
  });
  const dailySummaryText = completion1.choices[0]?.message?.content?.trim() ?? '';

  await db
    .insert(dailySummaries)
    .values({
      userId: user_id,
      summaryDate: todayStr,
      summaryText: dailySummaryText,
      strength: 3,
      lastAccessedAt: now,
    })
    .onConflictDoUpdate({
      target: [dailySummaries.userId, dailySummaries.summaryDate],
      set: {
        summaryText: dailySummaryText,
        strength: 3,
        lastAccessedAt: now,
      },
    });

  const { data: embed1 } = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: dailySummaryText,
  });
  const dailyVec = embed1[0]?.embedding;
  if (dailyVec?.length) {
    await index.upsert({
      namespace,
      records: [
        {
          id: `daily_${todayStr}`,
          values: dailyVec,
          metadata: {
            user_id: String(user_id),
            type: 'daily_summary',
            strength: 3,
            last_accessed: Math.floor(Date.now() / 1000),
            date: todayStr,
          },
        },
      ],
    });
  }

  const prevGlobal = globalRow?.globalSummaryText ?? '';
  const completion2 = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Update the global event summary with this new daily summary. Keep it cumulative and under 500 words.',
      },
      {
        role: 'user',
        content: `Previous global summary:\n${prevGlobal}\n\nNew daily summary:\n${dailySummaryText}`,
      },
    ],
  });
  const newGlobalText =
    (completion2.choices[0]?.message?.content?.trim() ?? prevGlobal) || dailySummaryText;

  const nextVersion = (globalRow?.version ?? 0) + 1;
  if (globalRow) {
    await db
      .update(userGlobalMemory)
      .set({
        globalSummaryText: newGlobalText,
        version: nextVersion,
        updatedAt: now,
        lastAccessedAt: now,
      })
      .where(eq(userGlobalMemory.userId, user_id));
  } else {
    await db.insert(userGlobalMemory).values({
      userId: user_id,
      globalSummaryText: newGlobalText,
      version: nextVersion,
      strength: 5,
      updatedAt: now,
      lastAccessedAt: now,
    });
  }

  const { data: embed2 } = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: newGlobalText,
  });
  if (embed2[0]?.embedding?.length) {
    await index.upsert({
      namespace,
      records: [
        {
          id: 'global_summary',
          values: embed2[0].embedding,
          metadata: {
            user_id: String(user_id),
            type: 'global_summary',
            strength: 5,
            last_accessed: Math.floor(Date.now() / 1000),
          },
        },
      ],
    });
  }

  const completion3 = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          "Based on today's dialogue, summarize the user's personality traits, preferences, and emotional tone in a short paragraph.",
      },
      { role: 'user', content: messagesText },
    ],
  });
  const dailyPersonality = completion3.choices[0]?.message?.content?.trim() ?? '';

  const prevPortrait = globalRow?.portraitText ?? '';
  const prevTraits = globalRow?.traitsJson ?? null;
  const completion4 = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Merge the new daily personality into the global portrait. Output valid JSON with keys: portrait_text (string), traits_json (object), conflicts (array of { trait_key, old_value, new_value }). Prefer newer and higher-strength when reconciling. Keep portrait_text under 400 words.',
      },
      {
        role: 'user',
        content: `Previous portrait:\n${prevPortrait}\nPrevious traits: ${JSON.stringify(prevTraits)}\n\nDaily personality:\n${dailyPersonality}`,
      },
    ],
  });
  const mergeRaw = completion4.choices[0]?.message?.content?.trim() ?? '{}';
  let portraitText = prevPortrait;
  let traitsJson = prevTraits;
  let conflicts: { trait_key: string; old_value: string; new_value: string }[] = [];
  try {
    const parsed = JSON.parse(mergeRaw);
    portraitText = parsed.portrait_text ?? prevPortrait;
    traitsJson = parsed.traits_json ?? prevTraits;
    conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
  } catch {
    portraitText = dailyPersonality || prevPortrait;
  }

  await db
    .update(userGlobalMemory)
    .set({
      portraitText,
      traitsJson,
      updatedAt: now,
      lastAccessedAt: now,
    })
    .where(eq(userGlobalMemory.userId, user_id));

  const { data: embed3 } = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: portraitText,
  });
  if (embed3[0]?.embedding?.length) {
    await index.upsert({
      namespace,
      records: [
        {
          id: 'portrait',
          values: embed3[0].embedding,
          metadata: {
            user_id: String(user_id),
            type: 'portrait',
            strength: 5,
            last_accessed: Math.floor(Date.now() / 1000),
          },
        },
      ],
    });
  }

  for (const c of conflicts) {
    await db.insert(memoryConflicts).values({
      userId: user_id,
      traitKey: c.trait_key,
      oldValue: c.old_value,
      newValue: c.new_value,
      status: 'pending',
    });
  }
}

const worker = new Worker<GenerateJobData>(
  'generate-daily-summaries',
  processor,
  {
    connection: workerConnection as ConnectionOptions,
    concurrency: 2,
  }
);

worker.on('completed', (job) => console.log(`Generate-daily-summaries job ${job.id} completed`));
worker.on('failed', (job, err) =>
  console.error(`Generate-daily-summaries job ${job?.id} failed:`, err)
);

console.log('Generate-daily-summaries worker running');
