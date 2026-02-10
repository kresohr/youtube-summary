# Local Development Setup - Solutions

## Issue #1: Frontend runs on port 8081 instead of 8080

**Cause**: Port 8080 is already in use by another process (Python process PID 1532)

**Solutions**:

### Option A: Free up port 8080 (if you don't need the other service)

```bash
# Find what's using port 8080
sudo lsof -i :8080

# Stop it if you don't need it
sudo kill <PID>
```

### Option B: Change Vite port in vite.config.ts

Update the server config to use a different port:

```typescript
server: {
  port: 3000,  // or any other available port
  host: '0.0.0.0',
  proxy: { ... }
}
```

### Option C: Accept 8081 (no action needed)

Vite automatically uses the next available port. Just use http://localhost:8081

---

## Issue #2: Backend crashes - PostgreSQL connection refused

**Cause**: No PostgreSQL running on localhost:25433

**✅ FIXED**: PostgreSQL container is now running on port 25433

The following changes were made:

1. ✅ Uncommented port mapping in `docker-compose.yml`
2. ✅ Started PostgreSQL container
3. ✅ Updated `backend/.env` with correct credentials

**Status**: Backend should now connect successfully. Just restart it:

```bash
cd backend
npm run dev
```

---

## Alternative: Use a different PostgreSQL instance

If you have another PostgreSQL instance running (like the one on port 5433), update `backend/.env`:

```bash
# For the postgres-foodie container on port 5433:
DATABASE_URL="postgresql://<user>:<password>@localhost:5433/youtube_summary_db"
```

You'll need to create the database and run migrations first.

---

## Complete Local Development Workflow

**Terminal 1 - Start PostgreSQL**:

```bash
cd /home/kreso/projects/youtube-summary
# Edit docker-compose.yml to uncomment the postgres port mapping
docker-compose up postgres -d
```

**Terminal 2 - Backend**:

```bash
cd /home/kreso/projects/youtube-summary/backend
# Make sure .env has correct DATABASE_URL
npm run dev
# → Backend runs on http://localhost:4000
```

**Terminal 3 - Frontend**:

```bash
cd /home/kreso/projects/youtube-summary/frontend
npm run dev
# → Frontend runs on http://localhost:8081 (or 8080 if available)
```

**Access**: Open http://localhost:8081/summary in your browser
