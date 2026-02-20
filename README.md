# YouTube Video Summary Automation System

Automated system that fetches the latest videos from configured YouTube channels, extracts transcripts, generates AI-powered summaries via OpenRouter, and displays them on a responsive web interface. Runs as a daily cron job inside Docker.

_Warning: This project was 'vibecoded' with guided assistance and personal architecture choosing from my side. Make sure you double-check all security related stuff if you plan to use it for production._

## Tech Stack

| Layer                | Technology                                        |
| -------------------- | ------------------------------------------------- |
| **Frontend**         | Vue.js 3 + TypeScript, Vite, Vue Router, Axios    |
| **Backend**          | Express.js 5 + TypeScript (Node 22), node-cron    |
| **Database**         | PostgreSQL 16 (raw SQL via `pg` driver)           |
| **Transcripts**      | youtube-transcript-plus (free, no API key needed) |
| **AI Summaries**     | OpenRouter API (free model tier available)        |
| **Auth**             | JWT (jsonwebtoken) + bcrypt                       |
| **Containerization** | Docker + Docker Compose                           |
| **Reverse Proxy**    | Nginx (production only, with Let's Encrypt SSL)   |

## Project Structure

```
youtube-summary/
├── docker-compose.yml        # Postgres + backend + frontend services
├── .env.example              # Template for environment variables
├── init-ssl.sh               # One-time SSL certificate script (production)
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── init.sql              # DB schema — runs on first postgres start
│   └── src/
│       ├── server.ts         # Express app, cron scheduler, health check
│       ├── seed.ts           # Seeds the default admin user
│       ├── lib/
│       │   └── db.ts         # PostgreSQL connection pool (pg)
│       ├── middleware/
│       │   ├── auth.ts       # JWT auth middleware
│       │   └── noIndex.ts    # X-Robots-Tag header
│       ├── routes/
│       │   ├── auth.ts       # POST /api/auth/login
│       │   ├── channels.ts   # CRUD /api/channels (protected)
│       │   ├── videos.ts     # GET  /api/videos (public)
│       │   └── admin.ts      # POST /api/admin/trigger-fetch (protected)
│       └── jobs/
│           ├── fetchVideos.ts       # Orchestrates fetch → transcript → summary → save
│           └── youtubeTranscript.ts # Transcript extraction via youtube-transcript-plus
│
├── frontend/
│   ├── Dockerfile            # Multi-stage: Vite build → Nginx static server
│   ├── package.json
│   ├── vite.config.ts        # Dev proxy /api → backend:4000
│   └── src/
│       ├── main.ts
│       ├── App.vue
│       ├── router.ts         # / (summaries), /configure (login), /configure/dashboard
│       ├── api.ts            # Axios instance with JWT interceptor
│       ├── style.css
│       ├── components/
│       │   └── VideoCard.vue # Card with thumbnail, summary, "View More" dialog
│       └── views/
│           ├── SummaryPage.vue      # Public video summary feed
│           ├── LoginPage.vue        # Admin login
│           └── AdminDashboard.vue   # Manage channels, trigger fetch
│
└── nginx/
    ├── nginx.conf            # Production HTTPS config
    └── init-nginx.conf       # Temp config for ACME challenge during SSL init
```

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) (v2+)
- A [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) key
- An [OpenRouter](https://openrouter.ai/) API key

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable             | Description                                                      | Required |
| -------------------- | ---------------------------------------------------------------- | -------- |
| `DB_USER`            | PostgreSQL username                                              | ✅       |
| `DB_PASSWORD`        | PostgreSQL password                                              | ✅       |
| `DB_NAME`            | PostgreSQL database name                                         | ✅       |
| `JWT_SECRET`         | Secret for JWT tokens — generate with `openssl rand -base64 32`  | ✅       |
| `YOUTUBE_API_KEY`    | YouTube Data API v3 key                                          | ✅       |
| `OPENROUTER_API_KEY` | OpenRouter API key for AI summaries                              | ✅       |
| `APP_URL`            | Public URL of the app (e.g. `https://yourdomain.com`)            | ✅       |
| `CORS_ORIGIN`        | Allowed frontend origin for CORS (e.g. `https://yourdomain.com`) | ✅       |
| `NODE_ENV`           | `production` or `development`                                    | ✅       |
| `PORT`               | Backend port inside the container (default `4000`)               | ❌       |
| `HTTP_PORT`          | Host HTTP port for Nginx (default `80`, production only)         | ❌       |
| `HTTPS_PORT`         | Host HTTPS port for Nginx (default `443`, production only)       | ❌       |
| `SSL_CERT_PATH`      | Path to Let's Encrypt certs (default `/etc/letsencrypt`)         | ❌       |

## Quick Start — Local Development

### Option A: Full Docker (recommended)

All three services (Postgres, backend, frontend) run in containers:

```bash
# 1. Clone and configure
git clone <your-repo-url> youtube-summary
cd youtube-summary
cp .env.example .env
# Edit .env — fill in DB_USER, DB_PASSWORD, DB_NAME, JWT_SECRET,
#              YOUTUBE_API_KEY, OPENROUTER_API_KEY
#              Set NODE_ENV=development

# 2. Start all services
docker compose up -d --build

# 3. Seed the default admin user (first time only)
docker compose exec backend npm run seed

# 4. Open the app
#    Frontend:  http://localhost:8081
#    Backend:   http://localhost:4001
```

### Option B: Docker for Postgres only, run backend & frontend natively

Useful for faster iteration with hot-reload:

```bash
# 1. Start only Postgres
docker compose up postgres -d

# 2. Backend (Terminal 1)
cd backend
cp ../.env .env   # or create backend/.env with DATABASE_URL
# Add to .env:  DATABASE_URL=postgresql://<DB_USER>:<DB_PASSWORD>@localhost:25433/<DB_NAME>
npm install
npm run seed      # first time only
npm run dev       # → http://localhost:4000

# 3. Frontend (Terminal 2)
cd frontend
npm install
npm run dev       # → http://localhost:8080
                  # Vite proxies /api requests to http://localhost:4000
```

### Default Admin Credentials

| Field    | Value      |
| -------- | ---------- |
| Username | `admin`    |
| Password | `admin123` |

> ⚠️ Change these immediately after first login via the database.

## Production Deployment (VPS)

### Prerequisites

- A VPS with Docker and Docker Compose installed
- A domain name with an **A record** pointed to your VPS IP
- Ports **80** and **443** open in your firewall

### Steps

```bash
# 1. Clone the repo
git clone <your-repo-url> youtube-summary
cd youtube-summary

# 2. Create .env from example and fill in your values
cp .env.example .env
nano .env    # fill in all required variables, set NODE_ENV=production

# 3. Start the core services (Postgres, backend, frontend)
docker compose up -d --build

# 4. Seed the default admin user (first time only)
docker compose exec backend npm run seed

# 5. Obtain initial SSL certificate (run ONCE)
chmod +x init-ssl.sh
./init-ssl.sh yourdomain.com your@email.com

# 6. Start Nginx (production profile)
docker compose --profile production up -d

# 7. Verify
curl -I https://yourdomain.com/health
```

### SSL Certificate Renewal

The `init-ssl.sh` script handles the initial certificate. For automatic renewal, set up a cron job on the host or add a Certbot sidecar container. To manually renew and reload:

```bash
docker run --rm \
  -v "${SSL_CERT_PATH:-/etc/letsencrypt}:/etc/letsencrypt" \
  certbot/certbot renew

docker compose exec nginx nginx -s reload
```

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                   Host / VPS                          │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ Nginx (production profile, ports 80/443)        │  │
│  │  HTTP :80  → redirect to HTTPS                  │  │
│  │  HTTPS :443                                     │  │
│  │   ├── /fetch/api/*       → backend  :4000       │  │
│  │   ├── /fetch/summary     → frontend :80         │  │
│  │   ├── /fetch/configure   → frontend :80         │  │
│  │   ├── /fetch/*           → frontend :80         │  │
│  │   └── /health            → backend  :4000       │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │
│  │  Frontend   │  │  Backend   │  │  PostgreSQL 16 │  │
│  │  (Nginx     │  │  Express   │  │                │  │
│  │   static)   │  │  :4000     │  │  :5432         │  │
│  │  :80        │  │            │  │  (host: 25433) │  │
│  └────────────┘  └────────────┘  └────────────────┘  │
│                         │                  │          │
│                         └──── pg driver ───┘          │
└───────────────────────────────────────────────────────┘
```

**Exposed ports for local development:**

| Service    | Container port | Host port |
| ---------- | -------------- | --------- |
| PostgreSQL | 5432           | 25433     |
| Backend    | 4000           | 4001      |
| Frontend   | 80             | 8081      |

## Cron Job

The backend automatically runs a video fetch & summarize job:

- **On startup** — runs once when the backend container starts
- **Daily at 05:00** — scheduled via `node-cron`

Each run:

1. Queries all configured YouTube channels from the database
2. Fetches videos published in the last 24 hours via the YouTube Data API
3. Skips videos already in the database
4. Extracts transcripts using `youtube-transcript-plus`
5. Generates summaries via the OpenRouter API
6. Saves video metadata and summary to PostgreSQL

You can also trigger a fetch manually from the Admin Dashboard.

## Frontend Routes

| Path                   | Auth | Description                                      |
| ---------------------- | ---- | ------------------------------------------------ |
| `/`                    | No   | Redirects to `/summary`                          |
| `/summary`             | No   | Public feed of all video summaries               |
| `/configure`           | No   | Admin login page                                 |
| `/configure/dashboard` | JWT  | Admin dashboard (manage channels, trigger fetch) |

## API Endpoints

| Method | Path                       | Auth | Description                  |
| ------ | -------------------------- | ---- | ---------------------------- |
| GET    | `/health`                  | No   | Health check                 |
| POST   | `/api/auth/login`          | No   | Login, returns JWT           |
| GET    | `/api/videos`              | No   | List videos (paginated)      |
| GET    | `/api/videos/:id`          | No   | Get single video             |
| GET    | `/api/channels`            | JWT  | List configured channels     |
| POST   | `/api/channels`            | JWT  | Add a channel by YouTube URL |
| DELETE | `/api/channels/:id`        | JWT  | Delete a channel             |
| POST   | `/api/admin/trigger-fetch` | JWT  | Manually trigger video fetch |

### Adding a Channel

The `POST /api/channels` body accepts a `channelUrl` (required) and an optional `channelName` (auto-detected from the YouTube API when omitted). Supported URL formats:

| Input       | Example                                                |
| ----------- | ------------------------------------------------------ |
| Handle URL  | `https://youtube.com/@mkbhd`                           |
| Channel URL | `https://youtube.com/channel/UCBcRF18a7Qf58cCRy5xuWwQ` |
| Custom URL  | `https://youtube.com/c/mkbhd`                          |
| User URL    | `https://youtube.com/user/mkbhd`                       |
| Bare handle | `@mkbhd`                                               |

## Database Schema

The database is initialized automatically by `backend/init.sql` when the PostgreSQL container starts for the first time.

**Tables:**

- `users` — admin accounts (username, bcrypt password)
- `youtube_channels` — tracked YouTube channels
- `videos` — fetched videos with AI-generated summaries, linked to channels via `channel_id`

## License

MIT
