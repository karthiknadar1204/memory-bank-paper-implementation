import { config } from 'dotenv';
config();

import { Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '../config/db';
import { conversationMessages, dailySummaries } from '../config/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import openai from '../config/openai';
import { generateDailySummariesQueue, generateGlobalSummariesQueue } from '../config/queue';

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
const THREE_MINUTES_MS = 3 * 60 * 1000;

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
  return /duplicate key.*daily_summaries/i.test(msg);
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

  const is3MinTrigger = job.data.trigger_reason === 'every_3_min';
  const todayMessagesQuery = db
    .select({ role: conversationMessages.role, content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.userId, user_id),
        gte(conversationMessages.createdAt, todayStart)
      )
    );

  const todayMessages = is3MinTrigger
    ? (await todayMessagesQuery.orderBy(desc(conversationMessages.createdAt)).limit(20)).reverse()
    : await todayMessagesQuery.orderBy(conversationMessages.createdAt);

  const messagesText = todayMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n');
  if (!messagesText.trim()) return;

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

  void generateGlobalSummariesQueue.add('generate', {
    user_id,
    trigger_reason: job.data.trigger_reason ?? 'after_daily',
  });
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

setInterval(async () => {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  try {
    const rows = await db
      .select({ userId: conversationMessages.userId })
      .from(conversationMessages)
      .where(gte(conversationMessages.createdAt, todayStart))
      .groupBy(conversationMessages.userId);
    for (const row of rows) {
      void generateDailySummariesQueue.add('generate', {
        user_id: row.userId,
        trigger_reason: 'every_3_min',
      });
    }
  } catch (err) {
    console.error('Daily summary 3-min schedule error:', err);
  }
}, THREE_MINUTES_MS);

console.log('Generate-daily-summaries worker running (every 8 messages + every 3 min)');
