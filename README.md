# Memory Bank Paper Implementation

A **personal AI companion backend** that implements a long-term memory system inspired by the Memory Bank paper. The system stores and retrieves memories, maintains daily and global summaries, builds a user portrait, and uses a retention model so the assistant stays context-aware across the entire relationship.

## What This Project Is About

- **Long-term memory**: User and assistant messages are stored and (for user messages) embedded in a vector store (Pinecone) for semantic retrieval.
- **Memory bank layers**: Raw messages, daily summaries (one per user per day), a cumulative global summary, and a user portrait (personality/traits) are all maintained and injected into the assistant’s context.
- **Retention & strength**: Memories decay over time via a retention score; frequently accessed memories get a strength bump and decay more slowly. The model is told which memories are “strong” vs “weaker.”
- **Async pipeline**: Ingest (embed + vectorize), daily summarization, and global summary/portrait updates run as background workers so chat stays fast.

## Tech Stack

| Layer        | Technology              |
| ------------ | ----------------------- |
| Runtime     | [Bun](https://bun.sh/)  |
| API         | [Hono](https://hono.dev/) |
| Database    | PostgreSQL (e.g. [Neon](https://neon.tech/)) with [Drizzle ORM](https://orm.drizzle.team/) |
| Vector DB   | [Pinecone](https://www.pinecone.io/) |
| Queues      | [BullMQ](https://docs.bullmq.io/) + Redis |
| AI          | [OpenAI](https://platform.openai.com/) (chat + embeddings) |

## Prerequisites

- **Bun** (recommended) or Node.js
- **PostgreSQL** (e.g. Neon)
- **Redis** (for BullMQ)
- **Pinecone** account and index
- **OpenAI** API key

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd memory-bank-paper-implementation/server
bun install
```

(If using npm: `npm install`.)

### 2. Environment variables

Create a `.env` file in the `server/` directory:

```env
# Required
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=sk-...
PINECONE_API_KEY=...
PINECONE_INDEX=your-index-name
JWT_SECRET=your-secret-for-cookies

# Optional
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
ENABLE_RETENTION_UPDATE=true
```

| Variable | Description |
| -------- | ----------- |
| `DATABASE_URL` | Postgres connection string (Neon or other). |
| `REDIS_URL` | Redis URL for BullMQ. |
| `OPENAI_API_KEY` | OpenAI API key. |
| `PINECONE_API_KEY` | Pinecone API key. |
| `PINECONE_INDEX` | Name of the Pinecone index (create one with dimensions matching your embedding model, e.g. 1536 for `text-embedding-3-small`). |
| `JWT_SECRET` | Secret used to sign/verify the auth cookie. |
| `OPENAI_CHAT_MODEL` | Chat model (default: `gpt-4o-mini`). |
| `OPENAI_EMBEDDING_MODEL` | Embedding model (default: `text-embedding-3-small`). |
| `ENABLE_RETENTION_UPDATE` | Set to `false` to disable the daily retention decay job. |

### 3. Database migrations

From the `server/` directory:

```bash
bun run migrate
```

This applies Drizzle migrations and creates tables: `users`, `conversation_messages`, `daily_summaries`, `user_global_memory`.

### 4. Run the app

**API server** (port 3004):

```bash
bun run dev
```

**Workers** (run each in a separate terminal, or use a process manager):

```bash
# Ingest: embed messages and upsert to Pinecone; triggers daily summary when needed
bun run worker:ingest

# Daily summaries: summarize today’s conversation; then enqueue global summary
bun run worker:daily

# Global summaries: update global summary and user portrait
bun run worker:global

# Retention: recompute retention scores every 24h (optional if ENABLE_RETENTION_UPDATE=true)
bun run worker:retention
```

For a minimal setup you need: **server + ingest worker**. Adding **daily** and **global** workers enables summaries and portrait; **retention** keeps decay up to date.

## Scripts Reference

| Script | Command | Description |
| ------ | ------- | ----------- |
| Dev server | `bun run dev` | Start API with hot reload on port 3004. |
| Ingest worker | `bun run worker:ingest` | Process ingest queue: embed and vectorize messages. |
| Daily summaries | `bun run worker:daily` | Generate/update daily summaries; enqueue global. |
| Global summaries | `bun run worker:global` | Update global summary and user portrait. |
| Retention | `bun run worker:retention` | Run retention decay pass once, then every 24h. |
| Migrate | `bun run migrate` | Run Drizzle migrations. |

## API Overview

### Auth (`/auth`)

- **POST `/auth/register`** – Body: `{ name, email, password }`. Creates user.
- **POST `/auth/login`** – Body: `{ email, password }`. Sets httpOnly cookie `token` (JWT).
- **POST `/auth/logout`** – Clears `token` cookie.
- **GET `/auth/user`** – Returns current user (requires cookie).

### Chat (require auth cookie)

- **POST `/chat`** – Body: `{ message }` (1–10,000 chars). Stores message, enqueues ingest, retrieves memories, calls OpenAI, stores assistant reply, returns `{ message, messageId }`.
- **POST `/ingest`** – Same flow as `/chat` but returns **202** with no body (fire-and-forget).

### Other

- **GET `/`** – Plain text greeting.
- **GET `/health`** – `{ status: 'ok', message: 'Server is running' }`.

## Architecture (High Level)

1. **Chat request** → Save user message → Enqueue ingest job → Retrieve context (portrait, global summary, daily summaries, top-k vector memories) → Bump strength for retrieved memories → Call OpenAI with system + recent messages → Save assistant message → Return reply.
2. **Ingest worker** → Embed message → Upsert to Pinecone (namespace `user_<id>`) → On “every 8 turns” or “new day”, enqueue daily-summary job.
3. **Daily summary worker** → Summarize today’s messages → Upsert `daily_summaries` → Enqueue global-summary job.
4. **Global summary worker** → Update cumulative global summary and user portrait (merge rules) in `user_global_memory`.
5. **Retention worker** → Once per 24h, recompute retention for all messages (DB + Pinecone metadata).

## Project Structure

```
server/
├── src/
│   ├── index.ts              # Hono app, routes, health
│   ├── config/               # DB, schema, queues, OpenAI, Pinecone
│   ├── controllers/         # auth, chat
│   ├── middleware/          # JWT auth
│   ├── routes/              # auth, chat routers
│   ├── services/            # retrieval (Pinecone + context building)
│   └── jobs/                # ingest, daily summaries, global summaries, retention
├── migrations/              # Drizzle SQL migrations
└── package.json
```

## License

Use and modify as needed for your project.
