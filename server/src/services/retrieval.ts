import { db } from '../config/db';
import {
  conversationMessages,
  dailySummaries,
  userGlobalMemory,
} from '../config/schema';
import { eq, sql, desc } from 'drizzle-orm';
import openai from '../config/openai';
import { index } from '../config/pinecone';

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const TOP_K = 15;
const RETENTION_THRESHOLD = 0.35;

type MatchMetadata = {
  user_id?: string;
  type?: string;
  strength?: number;
  last_accessed?: number;
  date?: string;
  message_id?: string;
  role?: string;
  text?: string;
  retention?: number;
};

function retentionFromMatch(meta: MatchMetadata): number {
  if (typeof meta.retention === 'number' && meta.retention >= 0) return meta.retention;
  const strength = typeof meta.strength === 'number' ? Math.max(1, meta.strength) : 1;
  const last = meta.last_accessed;
  if (last == null) return 1;
  const daysElapsed = (Date.now() / 1000 - last) / (24 * 60 * 60);
  return Math.exp(-daysElapsed / strength);
}

export async function retrieveAndBumpStrength(
  userId: number,
  queryText: string
): Promise<string> {
  const namespace = `user_${userId}`;
  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);

  const [globalRow] = await db
    .select({
      portraitText: userGlobalMemory.portraitText,
      globalSummaryText: userGlobalMemory.globalSummaryText,
    })
    .from(userGlobalMemory)
    .where(eq(userGlobalMemory.userId, userId))
    .limit(1);

  const portraitText = globalRow?.portraitText?.trim() || 'No portrait yet.';
  const globalSummaryText = globalRow?.globalSummaryText?.trim() || 'No global summary yet.';

  const recentDailySummaries = await db
    .select({ summaryDate: dailySummaries.summaryDate, summaryText: dailySummaries.summaryText })
    .from(dailySummaries)
    .where(eq(dailySummaries.userId, userId))
    .orderBy(desc(dailySummaries.summaryDate))
    .limit(14);

  const dailySection =
    recentDailySummaries.length > 0
      ? recentDailySummaries
          .map((r) => `[${String(r.summaryDate)}] ${r.summaryText}`)
          .join('\n\n')
      : 'None yet.';

  const { data: embedData } = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: queryText,
  });
  const vector = embedData[0]?.embedding;
  if (!vector?.length) {
    return [
      '<User Portrait>',
      portraitText,
      '',
      '<Past Events / Global Summary>',
      globalSummaryText,
      '',
      '<Daily Summaries>',
      dailySection,
      '',
      '<Relevant Memories>',
      'None yet.',
    ].join('\n');
  }

  const res = await index.query({
    vector,
    topK: TOP_K,
    namespace,
    includeMetadata: true,
    includeValues: false,
  });

  const matches = res.matches ?? [];
  const relevantMemories: string[] = [];

  const retentionInstruction = `Memories with retention ≥ ${RETENTION_THRESHOLD} are more reliable; prefer and push these forward when answering. Lower retention may be older or less reliable.`;

  for (const match of matches) {
    const id = match.id;
    const meta = (match.metadata ?? {}) as MatchMetadata;
    const type = meta.type ?? 'raw';
    const R = retentionFromMatch(meta);
    const newStrength = (typeof meta.strength === 'number' ? meta.strength : 1) + 1;

    try {
      await index.update({
        id,
        namespace,
        metadata: {
          ...meta,
          strength: newStrength,
          last_accessed: nowUnix,
          retention: 1,
        },
      });
    } catch (_) {}

    const textFromMeta = typeof meta.text === 'string' && meta.text.length > 0 ? meta.text : null;
    const datePrefix = meta.date ? `[${meta.date}] ` : '';
    const retentionLabel = R >= RETENTION_THRESHOLD ? ' [strong memory]' : ' [weaker memory]';

    if (type === 'raw' && id) {
      await db
        .update(conversationMessages)
        .set({
          strength: sql`${conversationMessages.strength} + 1`,
          lastAccessedAt: now,
          retention: 1,
        })
        .where(eq(conversationMessages.messageId, id));
      const content =
        textFromMeta ??
        (
          await db
            .select({ content: conversationMessages.content })
            .from(conversationMessages)
            .where(eq(conversationMessages.messageId, id))
            .limit(1)
        )[0]?.content;
      if (content)
        relevantMemories.push(`${datePrefix}Past message: ${content} (retention: ${R.toFixed(2)}${retentionLabel})`);
    }
  }

  const relevantSection =
    relevantMemories.length > 0
      ? `${retentionInstruction}\n\n${relevantMemories.join('\n\n')}`
      : 'None retrieved for this query.';

  return [
    '<User Portrait>',
    portraitText,
    '',
    '<Past Events / Global Summary>',
    globalSummaryText,
    '',
    '<Daily Summaries>',
    dailySection,
    '',
    '<Relevant Memories>',
    relevantSection,
  ].join('\n');
}
