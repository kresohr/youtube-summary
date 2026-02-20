# Copilot Instructions — YouTube Summary System

## Architecture Overview

Three-service Docker Compose app: **Vue 3 frontend** → **Express 5 backend** → **PostgreSQL 16**. No ORM — all database access uses raw SQL via the `pg` driver through a shared `query()` helper (`backend/src/lib/db.ts`). The backend also runs a **node-cron** job (daily at 05:00 + on startup) that orchestrates: YouTube Data API fetch → transcript extraction via `youtube-transcript-plus` → AI summary generation via OpenRouter → DB insert.

## Project Layout

- `backend/src/server.ts` — Express app entry, cron scheduler, health check
- `backend/src/jobs/fetchVideos.ts` — Core pipeline: fetch channels → get videos → transcribe → summarize → save
- `backend/src/jobs/youtubeTranscript.ts` — Transcript extraction wrapper
- `backend/src/routes/` — Express routers: `videos.ts` (public), `channels.ts` + `admin.ts` (JWT-protected), `auth.ts` (login)
- `backend/src/lib/db.ts` — `pg` Pool singleton, exports `query<T>(text, params)`
- `backend/src/middleware/auth.ts` — JWT Bearer token verification, extends `Request` as `AuthRequest`
- `backend/init.sql` — Schema: `users`, `youtube_channels`, `videos` (UUIDs via `gen_random_uuid()`)
- `frontend/src/api.ts` — Axios instance with JWT interceptor (token from `localStorage`)
- `frontend/src/router.ts` — Routes: `/` and `/summary` (public), `/configure` (login), `/configure/dashboard` (guarded)
- `frontend/src/components/MarkdownRenderer.vue` — Safe Markdown renderer using `marked` lexer + Vue `h()` (no `v-html`)

## Key Conventions

### Backend

- **Express 5** with TypeScript (compiled via `tsc`, dev via `tsx watch`). Module system: `NodeNext` — all local imports use `.js` extensions (`import { query } from "../lib/db.js"`).
- Route handlers return `Promise<void>` and send responses via `res.json()` / `res.status().json()`. No thrown HTTP errors — each handler has its own try/catch.
- All SQL uses parameterized queries (`$1`, `$2`, ...) — never interpolate values into SQL strings.
- UUIDs are generated DB-side (`gen_random_uuid()`). DB columns use `snake_case`; API responses map to `camelCase` in route handlers.
- Protected routes use `authMiddleware` from `middleware/auth.ts` as route-level middleware.

### Frontend

- **Vue 3 Composition API** with `<script setup lang="ts">` exclusively. No Options API.
- All API calls go through the shared `api` Axios instance (`src/api.ts`) — never use raw `axios` or `fetch`.
- Interfaces are defined inline in each component/view (no shared types directory).
- CSS is scoped per-component; global design tokens (colors, shadows, radius) are CSS custom properties in `style.css`.
- Markdown summaries rendered via `MarkdownRenderer.vue` component (using `marked.lexer` + VNodes, not `v-html`).

## Dev Workflow

```bash
# Start Postgres (Docker)
docker-compose up postgres -d      # Exposes port 25433

# Backend (Terminal 2)
cd backend
cp .env.example .env               # Set DATABASE_URL, JWT_SECRET, API keys
npm install && npm run dev          # tsx watch → localhost:4000

# Frontend (Terminal 3)
cd frontend
npm install && npm run dev          # Vite → localhost:8080, proxies /api → :4000

# Seed admin user (password: admin123)
cd backend && npm run seed
```

## API Routes

| Method | Path                       | Auth   | Purpose                                            |
| ------ | -------------------------- | ------ | -------------------------------------------------- |
| POST   | `/api/auth/login`          | Public | Returns JWT token                                  |
| GET    | `/api/videos`              | Public | List videos (paginated, filterable by `channelId`) |
| GET    | `/api/videos/:id`          | Public | Single video detail                                |
| GET    | `/api/channels`            | JWT    | List channels with video counts                    |
| POST   | `/api/channels`            | JWT    | Add channel (validates via YouTube API)            |
| DELETE | `/api/channels/:id`        | JWT    | Remove channel + cascade videos                    |
| POST   | `/api/admin/trigger-fetch` | JWT    | Manually trigger fetch pipeline                    |

## External Dependencies

- **YouTube Data API v3** (`YOUTUBE_API_KEY`) — channel validation + video search
- **OpenRouter API** (`OPENROUTER_API_KEY`) — AI summary generation (model: `openrouter/free`)
- **youtube-transcript-plus** — scrapes YouTube transcripts (no API key, but can be flaky)

## Gotchas

- Backend uses Express **v5** (not v4) — async route errors are handled natively, but the project still uses explicit try/catch in every handler.
- The transcript fetch can fail silently; the pipeline falls back to video description when transcript is too short (<100 chars).
- The `fetchAndSummarizeVideos` job processes channels sequentially and videos within each channel sequentially — no parallelism by design.
- Frontend derives the channel filter list from video data (not from a dedicated public channels endpoint), since `/api/channels` requires auth.
- The `MarkdownRenderer` intentionally avoids `v-html` for security — extend it by adding cases to `renderToken()` / `renderInlineTokens()`.
