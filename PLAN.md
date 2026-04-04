# omega-stream — Architecture & Implementation Plan

## Context

Build a multi-tenant video/audio restreaming SaaS on AWS. Users point OBS (or any RTMP client) at the service, configure output destinations (Twitch, YouTube, custom RTMP URLs), and the platform fans the stream out to all of them simultaneously. The product needs to be highly reliable, support multiple concurrent users with full isolation, and provide a dashboard UI for managing stream configs, monitoring live streams, and debugging.

---

## Architecture Overview

```
OBS / streaming client
        │ RTMP
        ▼
[NLB] → [Ingest Service]  ← nginx-rtmp on ECS
              │
              │ triggers via SQS
              ▼
        [Worker Service]  ← FFmpeg fan-out on ECS (one task per active stream)
              │ pushes to
        ┌─────┴──────┐
    Twitch.tv   YouTube   Custom RTMP ...

[API Service]  ←→  [PostgreSQL (Aurora Serverless v2)]
      │              [Redis (ElastiCache)]
      ▼
[Next.js Web UI]  →  CloudFront + S3 (or ECS)
```

---

## Services

### 1. Ingest Service (`services/ingest`)
- **nginx-rtmp** in Docker on ECS (EC2 launch type — Fargate has higher latency for long-lived TCP)
- Receives RTMP at `rtmp://ingest.omega-stream.io/live/{stream_key}`
- On `on_publish` nginx hook → HTTP POST to API to authenticate stream key and fetch outputs
- On `on_publish_done` → POST to API to mark stream ended
- Fronted by a **Network Load Balancer** (TCP/1935) — NLB is required for raw TCP, ALB cannot terminate RTMP
- Multi-AZ ECS service with at least 2 tasks; NLB does TCP health checks

### 2. Worker Service (`services/worker`)
- Node.js process that manages **FFmpeg** child processes for restreaming
- One worker task per user stream; spawns one FFmpeg process per output destination
- FFmpeg command: pulls from local nginx-rtmp's HLS/RTMP output, pushes to each `rtmp://` destination
- Listens on SQS queue for start/stop/update commands from the API
- Publishes stream health metrics (dropped frames, bitrate, reconnects) to CloudWatch + Redis
- ECS auto-scaling: scale out when SQS queue depth rises, scale in after stream ends

### 3. API Service (`apps/api`)
- **Node.js + TypeScript** with **Fastify** (better performance than Express, native TypeScript support)
- **Prisma ORM** + **Aurora PostgreSQL Serverless v2**
- **Redis (ElastiCache)** for live stream state (active streams, health metrics, current status)
- REST endpoints:
  - `POST /auth/*` — register, login, refresh tokens
  - `GET/POST/PUT/DELETE /outputs` — manage stream output destinations
  - `GET /stream` — get user's ingest URL + stream key
  - `POST /stream/key/rotate` — rotate stream key
  - `GET /streams/active` — list currently live outputs with health metrics
  - `POST /streams/{outputId}/stop` — force-stop a specific output
  - `GET /streams/logs/{outputId}` — tail FFmpeg stderr logs for debugging
- Auth: **JWT** (access + refresh token pattern), bcrypt for passwords
- Sends commands to workers via **SQS**
- Receives nginx `on_publish`/`on_publish_done` callbacks on an internal-only endpoint

### 4. Web UI (`apps/web`)
- **Next.js 14** (App Router) + **TypeScript** + **Tailwind CSS**
- Key pages:
  - `/dashboard` — stream status overview, go-live indicator, per-output health
  - `/outputs` — CRUD for output destinations (Twitch, YouTube, custom RTMP presets)
  - `/stream-setup` — shows user's ingest URL and stream key with copy buttons
  - `/logs` — real-time FFmpeg log tail via SSE or WebSocket
  - `/settings` — account, billing hooks
- Real-time updates via **Server-Sent Events** (SSE) from the API (simpler than WebSocket for one-way push)
- Deployed to **S3 + CloudFront** (static export) or ECS if SSR is needed for auth

---

## Data Model (PostgreSQL via Prisma)

```
User
  id, email, passwordHash, createdAt
  streamKey (unique, rotatable)
  tenantId (for future org-level billing)

Output
  id, userId, name, platform (enum: twitch|youtube|facebook|custom), rtmpUrl, streamKey
  enabled, createdAt, updatedAt

StreamSession
  id, userId, startedAt, endedAt, ingestBitrate
  → OutputSession (one per Output per session)
    id, sessionId, outputId, status (starting|live|error|stopped)
    lastError, reconnectCount, startedAt, endedAt
```

---

## AWS Infrastructure (CDK — `infra/`)

| Resource | Service | Notes |
|---|---|---|
| Ingest NLB | NLB (TCP 1935) | Multi-AZ, static IP via Elastic IP |
| Ingest ECS | ECS on EC2 (c6i.large) | nginx-rtmp, 2+ tasks |
| Worker ECS | ECS Fargate | Scales 0→N, one task per stream session |
| API ECS | ECS Fargate | ALB + HTTPS |
| Web | S3 + CloudFront | Static Next.js export |
| DB | Aurora PostgreSQL Serverless v2 | Auto-pauses at idle (dev), always-on prod |
| Cache | ElastiCache Redis (t4g.small) | Stream state, health metrics |
| Queue | SQS FIFO | API → Worker commands |
| Secrets | Secrets Manager | DB creds, JWT secret |
| Logs | CloudWatch Logs | All services |
| Alerts | CloudWatch Alarms + SNS | Worker crash, stream error rate |

---

## Monorepo Structure

```
omega-stream/
├── apps/
│   ├── api/          # Fastify API (Node.js/TypeScript)
│   └── web/          # Next.js frontend
├── services/
│   ├── ingest/       # nginx-rtmp Docker image + config
│   └── worker/       # FFmpeg manager (Node.js/TypeScript)
├── packages/
│   └── shared/       # Shared TypeScript types, Prisma client export
├── infra/            # AWS CDK (TypeScript)
├── docker-compose.yml  # Local dev (nginx-rtmp, postgres, redis)
└── package.json      # pnpm workspaces
```

---

## Key Reliability Decisions

- **nginx-rtmp on EC2** (not Fargate) avoids the cold-start latency of Fargate for persistent TCP connections
- **NLB over ALB** for RTMP — ALB is HTTP-only
- **FFmpeg reconnect flags** (`-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5`) on each output so transient destination failures don't kill the whole stream
- **Stream key auth on publish** — nginx calls API before accepting stream; invalid keys are rejected at the edge
- **Worker process supervision** — if FFmpeg for an output crashes, the worker restarts it up to N times and marks the output in error state (visible in UI) rather than silently dropping
- **SQS FIFO** per-user message group prevents race conditions on start/stop commands
- **Redis TTL on stream state** — if a worker crashes without cleanup, state expires and API reconciles on next poll

---

## Build & Dev Commands (target state)

```bash
# Install
pnpm install

# Local dev (starts postgres, redis, nginx-rtmp in Docker)
pnpm dev

# Per-app
pnpm --filter api dev
pnpm --filter web dev
pnpm --filter worker dev

# Tests
pnpm test              # all
pnpm --filter api test # single package

# DB
pnpm --filter api db:migrate
pnpm --filter api db:studio

# Infrastructure
cd infra && npx cdk deploy
```

---

## Implementation Order

1. **Monorepo scaffold** — pnpm workspaces, TypeScript base configs, shared package
2. **Database schema** — Prisma schema, migrations, seed script
3. **API** — Auth endpoints first, then outputs CRUD, then stream key management
4. **Ingest service** — nginx-rtmp Docker image, `on_publish` webhook integration with API
5. **Worker service** — FFmpeg process manager, SQS consumer, health reporting to Redis
6. **Web UI** — Auth pages → dashboard → outputs page → stream setup page → logs page
7. **CDK infra** — VPC, ECS clusters, RDS, ElastiCache, SQS, CloudFront
8. **End-to-end test** — Point local OBS at docker-compose ingest, verify fan-out

---

## Verification

- Local: `docker-compose up` → OBS streams to `rtmp://localhost:1935/live/test-key` → verify FFmpeg logs show push to a test RTMP sink (e.g. `rtmp://localhost:1936/live/output1`)
- API: Postman / Bruno collection hitting local Fastify
- UI: `pnpm --filter web dev` pointing at local API
- AWS: CDK deploy to a staging account, repeat OBS test against real ingest NLB
