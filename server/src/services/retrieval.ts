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

type MatchMetadata = {
  user_id?: string;
  type?: string;
  strength?: number;
  last_accessed?: number;
  date?: string;
  message_id?: string;
  role?: string;
  text?: string;
};

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

  for (const match of matches) {
    const id = match.id;
    const meta = (match.metadata ?? {}) as MatchMetadata;
    const type = meta.type ?? 'raw';
    const newStrength = (typeof meta.strength === 'number' ? meta.strength : 1) + 1;

    try {
      await index.update({
        id,
        namespace,
        metadata: {
          ...meta,
          strength: newStrength,
          last_accessed: nowUnix,
        },
      });
    } catch (_) {}

    const textFromMeta = typeof meta.text === 'string' && meta.text.length > 0 ? meta.text : null;
    const datePrefix = meta.date ? `[${meta.date}] ` : '';

    if (type === 'raw' && id) {
      await db
        .update(conversationMessages)
        .set({ strength: sql`${conversationMessages.strength} + 1`, lastAccessedAt: now })
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
      if (content) relevantMemories.push(`${datePrefix}Past message: ${content}`);
    }
  }

  const relevantSection =
    relevantMemories.length > 0 ? relevantMemories.join('\n\n') : 'None retrieved for this query.';

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
