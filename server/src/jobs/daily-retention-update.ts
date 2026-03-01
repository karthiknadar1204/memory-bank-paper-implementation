import { config } from 'dotenv';
config();

import { db } from '../config/db';
import { conversationMessages } from '../config/schema';
import { eq } from 'drizzle-orm';
import { index } from '../config/pinecone';

const RETENTION_THRESHOLD = 0.35;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function computeRetention(lastAccessedAt: Date, strength: number): number {
  const now = Date.now();
  const last = new Date(lastAccessedAt).getTime();
  const daysElapsed = (now - last) / ONE_DAY_MS;
  return Math.exp(-daysElapsed / Math.max(1, strength));
}

async function runPass() {
  const users = await db
    .select({ userId: conversationMessages.userId })
    .from(conversationMessages)
    .groupBy(conversationMessages.userId);

  for (const { userId } of users) {
    const messages = await db
      .select({
        messageId: conversationMessages.messageId,
        strength: conversationMessages.strength,
        lastAccessedAt: conversationMessages.lastAccessedAt,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.userId, userId));

    const namespace = `user_${userId}`;

    for (const msg of messages) {
      const R = computeRetention(msg.lastAccessedAt, msg.strength);

      await db
        .update(conversationMessages)
        .set({ retention: R })
        .where(eq(conversationMessages.messageId, msg.messageId));

      try {
        const fetched = await index.fetch({
          ids: [msg.messageId],
          namespace,
        });
        const record = fetched.records?.[msg.messageId];
        if (record?.metadata) {
          const meta = { ...record.metadata, retention: R };
          await index.update({
            id: msg.messageId,
            namespace,
            metadata: meta as Parameters<typeof index.update>[0]['metadata'],
          });
        }
      } catch (_) {
        // Vector might not exist (e.g. assistant message); skip Pinecone update
      }
    }
  }

  console.log('Daily retention update completed');
}

async function main() {
  if (process.env.ENABLE_RETENTION_UPDATE === 'false') {
    console.log('Retention update disabled by ENABLE_RETENTION_UPDATE');
    return;
  }
  await runPass();
  setInterval(runPass, ONE_DAY_MS);
  console.log('Daily retention update worker running (every 24h)');
}

main().catch((err) => {
  console.error('Retention update error:', err);
  process.exit(1);
});
