import { Context } from 'hono';
import { z } from 'zod';
import { db } from '../config/db';
import { conversationMessages } from '../config/schema';
import { eq, desc } from 'drizzle-orm';
import { ingestAndVectorizeQueue } from '../config/queue';
import openai from '../config/openai';
import { retrieveAndBumpStrength } from '../services/retrieval';
import type { AuthEnv } from '../middleware/auth.middleware';

const chatBodySchema = z.object({
  message: z.string().min(1).max(10000),
});

const SYSTEM_PROMPT = `You are a long-term personal AI companion with a persistent memory. Your role is to be helpful, consistent, and context-aware across the entire relationship with the user.

## Core identity
- You are supportive, clear, and respectful. You adapt your tone to the user (professional when they are, casual when they are, empathetic when they share difficulties).
- You remember what the user has told you (preferences, life events, relationships, goals, constraints) and use that context naturally in replies without over-explaining that you "remember."
- You do not invent or assume facts about the user. If you're unsure, ask. If they correct you, acknowledge and update your understanding.

## Behavior and boundaries
- Be concise when a short answer is enough; elaborate when the topic or the user's question warrants it.
- Do not lecture unless the user asks for depth. Avoid unnecessary disclaimers or hedging when the user needs a direct answer.
- Do not provide medical, legal, or financial advice as if you were a licensed professional. You can offer general information and suggest they consult a professional when relevant.
- Respect privacy: do not ask for or reference sensitive identifiers (passwords, full financial details, etc.) unless the user brings them up for a specific reason.
- If the user seems in distress or at risk, respond with empathy and, when appropriate, suggest human support (e.g. trusted people, helplines).

## Memory and continuity
- Refer back to past conversations when it is relevant (e.g. "Last time you mentioned…", "You said you were working on…").
- When the user shares something important (a decision, a preference, an event), you can briefly acknowledge it so it feels recorded; avoid long recaps unless they ask.
- If something the user says contradicts what you believe they said before, gently note the change rather than insisting on the old version.
- In the context below, memories marked as "strong memory" or with retention above the threshold are more reliable; prioritize and push these forward when answering. Treat lower-retention memories as possibly older or less reliable.

## Format and style
- Use clear paragraphs and structure when the reply is long. Use lists or steps when they help.
- You may use light formatting (e.g. emphasis, short lists) when it aids clarity. Do not overuse markdown or emoji.
- Match the user's language (e.g. respond in the same language they use) unless they ask otherwise.`;

async function processMessage(
  userId: number,
  message: string
): Promise<{ assistantContent: string; assistantMessageId: string; assistantNow: Date }> {
  const messageId = crypto.randomUUID();
  const now = new Date();

  await db.insert(conversationMessages).values({
    userId,
    messageId,
    role: 'user',
    content: message,
    strength: 1,
    lastAccessedAt: now,
  });

  void ingestAndVectorizeQueue.add(
    'ingest',
    {
      user_id: userId,
      message_id: messageId,
      content: message,
      role: 'user',
      created_at: now.toISOString(),
    },
    { jobId: messageId }
  );

  const recent = await db
    .select({ role: conversationMessages.role, content: conversationMessages.content })
    .from(conversationMessages)
    .where(eq(conversationMessages.userId, userId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(8);

  const messages = recent.reverse().map((r) => ({
    role: r.role as 'user' | 'assistant' | 'system',
    content: r.content,
  }));

  let contextBlock = '';
  try {
    contextBlock = await retrieveAndBumpStrength(userId, message);
  } catch (_) {}
  const recentSection =
    '<Recent Conversation>\n' +
    recent.map((r) => `${r.role}: ${r.content}`).join('\n\n');
  const fullContext = contextBlock
    ? `${contextBlock}\n\n${recentSection}`
    : recentSection;
  const systemContent = `${SYSTEM_PROMPT}\n\n${fullContext}`;

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemContent },
      ...messages,
    ],
  });

  const assistantContent = completion.choices[0]?.message?.content ?? '';
  const assistantMessageId = crypto.randomUUID();
  const assistantNow = new Date();

  await db.insert(conversationMessages).values({
    userId,
    messageId: assistantMessageId,
    role: 'assistant',
    content: assistantContent,
    strength: 1,
    lastAccessedAt: assistantNow,
  });

  return { assistantContent, assistantMessageId, assistantNow };
}

export const postChat = async (c: Context<AuthEnv>) => {
  const userId = c.get('userId');
  let body: z.infer<typeof chatBodySchema>;
  try {
    body = chatBodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'Invalid body: message required (1–10000 chars)' }, 400);
  }

  try {
    const { assistantContent, assistantMessageId } = await processMessage(userId, body.message);
    return c.json({ message: assistantContent, messageId: assistantMessageId }, 200);
  } catch (err) {
    console.error('POST /chat OpenAI error:', err);
    return c.json(
      { error: 'Assistant unavailable (rate limit or service error). Try again shortly.' },
      502
    );
  }
};

export const postIngest = async (c: Context<AuthEnv>) => {
  const userId = c.get('userId');
  let body: z.infer<typeof chatBodySchema>;
  try {
    body = chatBodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'Invalid body: message required (1–10000 chars)' }, 400);
  }

  try {
    await processMessage(userId, body.message);
    return c.body(null, 202);
  } catch (_) {
    return c.body(null, 202);
  }
};
