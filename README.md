# Omega Stream

A self-hosted multi-output live streaming platform. Ingest a single RTMP stream and restream it to multiple destinations (Twitch, YouTube, etc.) simultaneously.

## Architecture

```
┌────────────┐    RTMP     ┌────────┐   SQS    ┌────────┐   RTMP    ┌───────────┐
│   OBS /    │───────────▶│ Ingest │────────▶│ Worker │──────────▶│  Twitch/  │
│  Streamer  │             │ (nginx)│          │(FFmpeg)│           │  YouTube  │
└────────────┘             └────────┘          └────────┘           └───────────┘
                                                    │
                               ┌────────────────────┘
                               ▼
                     ┌──────────────────┐
                     │   API (Fastify)  │◀──────▶ Postgres + Redis
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
| `services/ingest` | nginx-rtmp ingestion service |
| `services/worker` | FFmpeg restreaming worker (SQS consumer) |
| `packages/shared` | Shared TypeScript utilities |
| `infra` | AWS CDK infrastructure |

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

This single command starts Postgres, Redis, ElasticMQ, the ingest server, and all application dev servers.

If you prefer to start things individually:

```bash
# Start only Docker infrastructure
docker-compose up -d

# Push the database schema (no migrations — we use db push)
cd apps/api && pnpm db:push

# Run individual services
pnpm --filter @omega-stream/api dev
pnpm --filter @omega-stream/web dev
pnpm --filter @omega-stream/worker dev
```

## Access Points

| Service | URL |
|---------|-----|
| Web UI | http://localhost:3002 |
| API | http://localhost:3000 |
| RTMP ingest | rtmp://localhost:1935/live |
| ElasticMQ console | http://localhost:9325 |
| Prisma Studio | `cd apps/api && pnpm db:studio` |

## Environment Variables

All config lives in the root `.env` file (see `.env.example` for defaults). Key variables:

- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis connection string
- `JWT_SECRET` — Secret for signing auth tokens
- `INGEST_URL_BASE` — Base RTMP URL the ingest server listens on
- `SQS_QUEUE_URL` / `SQS_ENDPOINT` — SQS queue (ElasticMQ locally)

## Running Tests

```bash
# Run all tests across the monorepo
pnpm test

# Run tests for a specific package
pnpm --filter @omega-stream/api test
pnpm --filter @omega-stream/web test
pnpm --filter @omega-stream/worker test

# Watch mode (where supported)
cd apps/web && pnpm test:watch
```

## Debugging

### API (Fastify)

Attach a Node.js debugger to the API server:

```bash
cd apps/api
node --inspect -r tsx/esm src/index.ts
```

Then connect from VS Code using the "Attach to Node Process" launch config, or open `chrome://inspect`.

### Worker (FFmpeg)

```bash
cd services/worker
node --inspect -r tsx/esm src/index.ts
```

To see FFmpeg command output, set `LOG_LEVEL=debug` in your `.env`.

### Web (Next.js)

Next.js has built-in debugging support:

```bash
cd apps/web
NODE_OPTIONS='--inspect' next dev --port 3002
```

### VS Code Launch Config

Add this to `.vscode/launch.json` to debug any service:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug API",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["--filter", "@omega-stream/api", "dev"],
      "console": "integratedTerminal",
      "env": { "NODE_OPTIONS": "--inspect" }
    },
    {
      "name": "Debug Worker",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["--filter", "@omega-stream/worker", "dev"],
      "console": "integratedTerminal",
      "env": { "NODE_OPTIONS": "--inspect" }
    }
  ]
}
```

### Docker Services

```bash
# View logs for a specific container
docker-compose logs -f ingest
docker-compose logs -f postgres

# Shell into a running container
docker-compose exec postgres psql -U omega omega_stream

# Restart a single service
docker-compose restart ingest
```

### Common Issues

**Port conflicts** — If ports 5432, 6379, 1935, or 3000-3002 are in use, stop conflicting services or change ports in `.env` and `docker-compose.yml`.

**Database out of sync** — After pulling schema changes, run:
```bash
cd apps/api && pnpm db:push
```

**Worker not picking up jobs** — Check that ElasticMQ is running (`docker-compose ps`) and `SQS_ENDPOINT` in `.env` points to `http://localhost:9324`.

## Database

We use Prisma with `db push` (no migration files). The schema lives at `apps/api/prisma/schema.prisma`.

```bash
# Sync schema to database
cd apps/api && pnpm db:push

# Browse data
cd apps/api && pnpm db:studio

# Regenerate Prisma client after schema changes
cd apps/api && pnpm db:generate
```

## Deployment

Infrastructure is defined in the `infra/` directory using AWS CDK.

```bash
cd infra
pnpm build
pnpm synth   # preview CloudFormation
pnpm deploy  # deploy to AWS
```
