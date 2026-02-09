# YouTube Video Summary Automation System

Automated YouTube video summary system that runs as a cron job. Fetches latest videos from specified YouTube channels daily, extracts transcripts using TubeText, generates AI summaries via OpenRouter, and displays them on a responsive web interface.

## Tech Stack

- **Backend:** Express.js (TypeScript)
- **Frontend:** Vue.js 3 (TypeScript)
- **Database:** PostgreSQL with Prisma 7
- **Reverse Proxy:** Nginx with automatic SSL (Let's Encrypt / Certbot)
- **Containerization:** Docker + Docker Compose
- **Authentication:** Simple JWT
- **Transcript Extraction:** TubeText (free, no API key needed)
- **AI Summarization:** OpenRouter API

## Quick Start (Development)

1. Copy `.env.example` to `.env` and fill in your API keys
2. Run `docker compose up -d` (starts postgres, backend, frontend — no nginx)
3. Access the app via `http://localhost:8080`

## Production Deployment (VPS)

See the **VPS Deployment** section below.

## Default Admin Credentials

- Username: `admin`
- Password: `admin123` (change immediately after first login!)

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `DB_USER` | PostgreSQL username | ✅ |
| `DB_PASSWORD` | PostgreSQL password | ✅ |
| `DB_NAME` | PostgreSQL database name | ✅ |
| `JWT_SECRET` | Secret for JWT tokens — generate with `openssl rand -base64 32` | ✅ |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key | ✅ |
| `OPENROUTER_API_KEY` | OpenRouter API key for AI summaries | ✅ |
| `APP_URL` | Public URL of the app (e.g. `https://yourdomain.com/fetch`) | ✅ |
| `NODE_ENV` | `production` or `development` | ✅ |
| `HTTP_PORT` | Host HTTP port (default `80`) | ❌ |
| `HTTPS_PORT` | Host HTTPS port (default `443`) | ❌ |
| `SSL_CERT_PATH` | Path to Let's Encrypt certs (default `./nginx/certs`) | ❌ |

## Architecture

```
nginx (ports 80/443, production profile)
├── HTTP :80        → redirect to HTTPS
├── HTTPS :443
│   ├── /fetch/summary     → frontend (Vue.js :8080)
│   ├── /fetch/configure   → frontend (Vue.js :8080)
│   ├── /fetch/api/*       → backend  (Express.js :4000)
│   ├── /fetch/*           → frontend static assets
│   └── /health            → backend health check
│
certbot (auto-renews certs every 12h)

postgres :5432 (exposed as 25433 on host)
```

## Cron Job

- Runs daily at 05:00 AM server time
- Also runs once on server startup
- Fetches latest videos from all configured YouTube channels
- Extracts transcripts via TubeText
- Generates summaries via OpenRouter

## VPS Deployment

### Prerequisites
- A VPS with Docker and Docker Compose installed
- A domain name pointed to your VPS IP (A record)
- Ports 80 and 443 open in your firewall

### Steps

```bash
# 1. Clone the repo
git clone <your-repo-url> youtube-summary
cd youtube-summary

# 2. Create .env from example and fill in your values
cp .env.example .env
nano .env    # fill in all required variables

# 3. Start the core services (postgres, backend, frontend)
docker compose up -d --build

# 4. Run database migrations & seed
docker compose exec backend npx prisma migrate deploy
docker compose exec backend npx prisma db seed

# 5. Obtain initial SSL certificate (run ONCE)
./init-ssl.sh yourdomain.com your@email.com

# 6. Start nginx + certbot (production profile)
docker compose --profile production up -d

# 7. Verify
curl -I https://yourdomain.com/health
```

### SSL Certificate Renewal
The `certbot` container automatically renews certificates every 12 hours.
Nginx picks up new certs on its next reload. To manually force a reload:
```bash
docker compose exec nginx nginx -s reload
```
