import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // Required by BullMQ for blocking commands (workers)
  enableReadyCheck: false, // Required by BullMQ
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    console.error('Queue Redis connection error:', err.message);
    return true;
  },
});

/** Shared Redis connection for Queue producers. When you add Workers, create a separate IORedis connection for each worker (BullMQ recommendation). */
export const connection = redis as ConnectionOptions;

redis.on('connect', () => {
  console.log('Queue: Redis connected');
});

redis.on('error', (err) => {
  console.error('Queue: Redis error:', err);
});

redis.on('ready', () => {
  console.log('Queue: Redis ready');
});

if (!process.env.REDIS_URL) {
  console.error('WARNING: REDIS_URL not set. Queues may not work correctly.');
}



export const ingestAndVectorizeQueue = new Queue('ingest-and-vectorize', {
  connection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: 10 },
});

export const generateDailySummariesQueue = new Queue('generate-daily-summaries', {
  connection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: 10 },
});