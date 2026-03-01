import { config } from 'dotenv';
config();

import { Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '../config/db';
import {
  conversationMessages,
  dailySummaries,
  userGlobalMemory,
} from '../config/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import openai from '../config/openai';

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

const workerConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

type GenerateJobData = {
  user_id: number;
  trigger_reason?: string;
};

function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code !== '23505') return false;
  const msg = String(e?.message ?? '');
  return /duplicate key.*user_global_memory/i.test(msg);
}

async function processor(job: { data: GenerateJobData }) {
  const { user_id } = job.data;

  try {
    await runProcessor(job);
  } catch (err) {
    if (isDuplicateKeyError(err)) return;
    throw err;
  }
}

async function runProcessor(job: { data: GenerateJobData }) {
  const { user_id } = job.data;

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayStr = todayStart.toISOString().split('T')[0];

  const [dailyRow] = await db
    .select({ summaryText: dailySummaries.summaryText })
    .from(dailySummaries)
    .where(
      and(
        eq(dailySummaries.userId, user_id),
        eq(dailySummaries.summaryDate, todayStr)
      )
    )
    .limit(1);

  const dailySummaryText = dailyRow?.summaryText?.trim();
  if (!dailySummaryText) return;

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
  await db
    .insert(userGlobalMemory)
    .values({
      userId: user_id,
      globalSummaryText: newGlobalText,
      version: nextVersion,
      strength: 5,
      updatedAt: now,
      lastAccessedAt: now,
    })
    .onConflictDoUpdate({
      target: userGlobalMemory.userId,
      set: {
        globalSummaryText: newGlobalText,
        version: sql`${userGlobalMemory.version} + 1`,
        updatedAt: now,
        lastAccessedAt: now,
      },
    });

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

  const mergePrompt = `Current portrait:
${prevPortrait || '(none)'}

New daily personality:
${dailyPersonality}

Rules for updating the portrait:
- Prefer newer information.
- Prefer information with higher strength.
- If both sides are strong, keep a short version history in the portrait, e.g. "Used to say they disliked X (early 2025) → now enjoys X regularly."
- Stay concise, natural and positive.
Output valid JSON only, with keys: portrait_text (string, 1-4 sentences), traits_json (object). No other keys.`;

  const completion4 = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Update the user portrait using the rules. Output only valid JSON with keys portrait_text and traits_json.',
      },
      { role: 'user', content: mergePrompt },
    ],
  });
  const mergeRaw = completion4.choices[0]?.message?.content?.trim() ?? '{}';
  let portraitText = prevPortrait;
  let traitsJson = prevTraits;
  try {
    const parsed = JSON.parse(mergeRaw);
    portraitText = parsed.portrait_text ?? prevPortrait;
    traitsJson = parsed.traits_json ?? prevTraits;
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
}

const worker = new Worker<GenerateJobData>(
  'generate-global-summaries',
  processor,
  {
    connection: workerConnection as ConnectionOptions,
    concurrency: 2,
  }
);

worker.on('completed', (job) => console.log(`Generate-global-summaries job ${job.id} completed`));
worker.on('failed', (job, err) =>
  console.error(`Generate-global-summaries job ${job?.id} failed:`, err)
);

console.log('Generate-global-summaries worker running');
