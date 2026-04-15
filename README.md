# Sruth

A self-hosted multi-output live streaming relay. Ingest a single RTMP or SRT stream and relay it to multiple destinations (Twitch, YouTube, etc.) simultaneously.

## Architecture

```
┌────────────┐  RTMP/SRT   ┌──────────┐          ┌────────┐   RTMP    ┌───────────┐
│   OBS /    │────────────▶│  Ingest  │          │ Worker │──────────▶│  Twitch/  │
│  Streamer  │              │(MediaMTX)│          │(FFmpeg)│           │  YouTube  │
└────────────┘              └──────────┘          └────────┘           └───────────┘
                                                      │
                               ┌──────────────────────┘
                               ▼
                     ┌──────────────────┐
                     │   API (Fastify)  │◀──────▶ Postgres
                     └──────────────────┘
                               ▲
                               │
                     ┌──────────────────┐
                     │   Web (Next.js)  │
                     └──────────────────┘
```

**Monorepo layout:**

| Path | Description |
|------|-------------|
| `apps/api` | Fastify REST API (auth, stream management, outputs) |
| `apps/web` | Next.js frontend |
| `services/ingest` | MediaMTX ingestion service (RTMP + SRT) |
| `services/worker` | FFmpeg restreaming worker |
| `packages/shared` | Shared TypeScript types and Prisma schema |

## Prerequisites

- **Node.js 22** (see `.nvmrc`)
- **pnpm** >= 10
- **Docker** & Docker Compose
- **FFmpeg** (for the worker service in local dev)

## Getting Started

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment config
cp .env.example .env

# 3. Start everything (Docker services + all dev servers)
pnpm dev
```

This starts Postgres, the ingest server, and all application dev servers.

If you prefer to start things individually:

```bash
# Start only Docker infrastructure
docker-compose up -d

# Push the database schema
cd apps/api && pnpm db:push

# Run individual services
pnpm --filter @sruth/api dev
pnpm --filter @sruth/web dev
pnpm --filter @sruth/worker dev
```

## Access Points

| Service | URL |
|---------|-----|
| Web UI | http://localhost:3002 |
| API | http://localhost:3000 |
| RTMP ingest | rtmp://localhost:1935/live |
| SRT ingest | srt://localhost:9999 |
| Prisma Studio | `cd apps/api && pnpm db:studio` |

## Running Tests

```bash
# Run all tests across the monorepo
pnpm test

# Run tests for a specific package
pnpm --filter @sruth/api test
pnpm --filter @sruth/web test
pnpm --filter @sruth/worker test
```

## Database

We use Prisma with `db push` for iterative dev. The schema lives at `packages/shared/prisma/schema.prisma`.

```bash
# Sync schema to database
cd apps/api && pnpm db:push

# Browse data
cd apps/api && pnpm db:studio

# Regenerate Prisma client after schema changes
cd apps/api && pnpm db:generate
```

## Deployment

Single-VM deployment on Hetzner with Docker Compose and Caddy for TLS.

```bash
# On the VM:
docker compose -f docker-compose.prod.yml up -d --build
```
