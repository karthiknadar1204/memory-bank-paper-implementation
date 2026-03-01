import { config } from 'dotenv';
config();

import { Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '../config/db';
import { conversationMessages, dailySummaries } from '../config/schema';
import { eq, and, gte, sql, desc } from 'drizzle-orm';
import openai from '../config/openai';
import { index } from '../config/pinecone';
import { generateDailySummariesQueue } from '../config/queue';

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

const workerConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

type IngestJobData = {
  user_id: number;
  message_id: string;
  content: string;
  role: string;
  created_at: string;
};

async function processor(job: { data: IngestJobData }) {
  const { user_id, message_id, content, role, created_at } = job.data;

  const existing = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.messageId, message_id))
    .limit(1);
  if (existing.length === 0) return;

  try {
    const { data: embedData } = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: content,
    });
    const values = embedData[0]?.embedding;
    if (!values || !Array.isArray(values)) throw new Error('No embedding returned');

    const dateStr = created_at.split('T')[0];
    const createdTimestamp = Math.floor(new Date(created_at).getTime() / 1000);
    const namespace = `user_${user_id}`;

    await index.upsert({
      namespace,
      records: [
        {
          id: message_id,
          values,
          metadata: {
            user_id: String(user_id),
            type: 'raw',
            strength: 1,
            last_accessed: createdTimestamp,
            date: dateStr,
            message_id,
            role,
            text: content.slice(0, 3000),
            retention: 1,
          },
        },
      ],
    });

    await db
      .update(conversationMessages)
      .set({ strength: 1, lastAccessedAt: new Date(), retention: 1 })
      .where(eq(conversationMessages.messageId, message_id));

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const [{ count: turnsToday }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.userId, user_id),
          gte(conversationMessages.createdAt, todayStart)
        )
      );

    const lastSummary = await db
      .select({ summaryDate: dailySummaries.summaryDate })
      .from(dailySummaries)
      .where(eq(dailySummaries.userId, user_id))
      .orderBy(desc(dailySummaries.summaryDate))
      .limit(1);

    const lastSummaryDateRaw = lastSummary[0]?.summaryDate;
    const lastSummaryDateObj = lastSummaryDateRaw
      ? new Date(String(lastSummaryDateRaw) + 'T00:00:00Z')
      : null;
    const todayDateObj = new Date(dateStr + 'T00:00:00Z');
    const isNewDay = !lastSummaryDateObj || lastSummaryDateObj.getTime() < todayDateObj.getTime();

    if ((turnsToday > 0 && turnsToday % 8 === 0) || isNewDay) {
      void generateDailySummariesQueue.add('generate', {
        user_id,
        trigger_reason: isNewDay ? 'new_day' : 'every_8_turns',
      });
    }
  } catch (err) {
    console.error(`Ingest failed for ${message_id}:`, err);
    throw err;
  }
}

const worker = new Worker<IngestJobData>(
  'ingest-and-vectorize',
  processor,
  {
    connection: workerConnection as ConnectionOptions,
    concurrency: 5,
  }
);

worker.on('completed', (job) => console.log(`Ingest job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`Ingest job ${job?.id} failed:`, err));

console.log('Ingest worker running');
