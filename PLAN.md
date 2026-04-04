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
[Next.js Web UI]  →  CloudFront + ALB + ECS (SSR)
```

---

## Services

### 1. Ingest Service (`services/ingest`)
- **nginx-rtmp** in Docker on **ECS Fargate** with a warm pool (minimum idle tasks always running to eliminate cold-start latency for incoming RTMP connections)
- Receives RTMP at `rtmp://ingest.omega-stream.io/live/{stream_key}`
- On `on_publish` nginx hook → HTTP POST to API (includes ingest task IP) to authenticate stream key and fetch outputs
- On `on_publish_done` → POST to API to mark stream ended
- If a stream reconnects to a different ingest task after restart/failover, the new `on_publish` callback naturally fires from the new task's IP
- Fronted by a **Network Load Balancer** (TCP/1935) — NLB is required for raw TCP, ALB cannot terminate RTMP
- Multi-AZ ECS service; NLB does TCP health checks; minimum desired count ensures warm capacity

### 2. Worker Service (`services/worker`)
- Node.js process that manages **FFmpeg** child processes for restreaming
- One worker task per user stream; spawns one FFmpeg process per output destination using `-c copy` (no transcode — streams are forwarded as-is from ingest)
- FFmpeg command: pulls from ingest task's RTMP output (ingest IP provided in SQS start message), pushes to each `rtmp://` destination
- Listens on SQS queue for start/stop/update/`ingest_relocated` commands from the API
- On `ingest_relocated` message: tears down FFmpeg processes and reconnects to the new ingest IP
- Publishes stream health metrics (dropped frames, bitrate, reconnects) to CloudWatch + Redis
- **ECS Fargate** with a warm pool — maintain minimum idle "sentinel" tasks polling SQS so new streams start sub-second; auto-scale to keep spare capacity at `max(3, active_streams * 0.2)`

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
- Sends commands to workers via **SQS** (start, stop, update, `ingest_relocated`)
- Receives nginx `on_publish`/`on_publish_done` callbacks on an internal-only endpoint
- On `on_publish`: records the ingest task IP from the callback, includes it in the SQS start message to the worker. If a stream is already active but the ingest IP changed (task restart/failover), sends an `ingest_relocated` message instead

### 4. Web UI (`apps/web`)
- **Next.js 14** (App Router) + **TypeScript** + **Tailwind CSS**
- Key pages:
  - `/dashboard` — stream status overview, go-live indicator, per-output health
  - `/outputs` — CRUD for output destinations (Twitch, YouTube, custom RTMP presets)
  - `/stream-setup` — shows user's ingest URL and stream key with copy buttons
  - `/logs` — real-time FFmpeg log tail via SSE or WebSocket
  - `/settings` — account, billing hooks
- Real-time updates via **Server-Sent Events** (SSE) from the API (simpler than WebSocket for one-way push)
- Deployed to **ECS Fargate** (SSR) behind **ALB + CloudFront** — SSR is required for SSE real-time updates and auth; ECS is consistent with the rest of the stack and avoids Lambda timeout/streaming limitations of Amplify Hosting

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
  id, userId, startedAt, endedAt, avgBitrate, peakBitrate
  → OutputSession (one per Output per session)
    id, sessionId, outputId, status (starting|live|error|stopped)
    lastError, reconnectCount, startedAt, endedAt
```

**Stream metrics strategy:**
- **Real-time bitrate**: stored in Redis (`stream:{sessionId}:bitrate`) with short TTL, read by dashboard via SSE
- **Time-series history**: worker pushes bitrate samples as CloudWatch custom metrics — gives min/avg/max/p99 with 15-month retention, no extra infrastructure
- **Post-session summary**: on session end, API pulls aggregates from CloudWatch via `GetMetricStatistics` and writes `avgBitrate`/`peakBitrate` to `StreamSession`

---

## AWS Infrastructure (CDK — `infra/`)

| Resource | Service | Notes |
|---|---|---|
| Ingest NLB | NLB (TCP 1935) | Multi-AZ, static IP via Elastic IP |
| Ingest ECS | ECS Fargate | nginx-rtmp, warm pool with min idle tasks |
| Worker ECS | ECS Fargate | Warm pool with sentinel tasks, scales with active streams |
| API ECS | ECS Fargate | ALB + HTTPS |
| Web | ECS Fargate + ALB + CloudFront | Next.js SSR |
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

- **Fargate warm pools** for both ingest and worker — minimum idle tasks eliminate cold-start latency without the ops burden of EC2 (no AMI management, no OS patching). Uniform infrastructure across all services
- **NLB over ALB** for RTMP — ALB is HTTP-only
- **FFmpeg reconnect flags** (`-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5`) on each output so transient destination failures don't kill the whole stream
- **Stream key auth on publish** — nginx calls API before accepting stream; invalid keys are rejected at the edge
- **Worker process supervision** — if FFmpeg for an output crashes, the worker restarts it up to N times and marks the output in error state (visible in UI) rather than silently dropping
- **Ingest IP passed via SQS** — `on_publish` callback includes the ingest task IP; API forwards it in the SQS start message so workers connect directly to the correct ingest task. On ingest task restart/failover, the stream reconnects via NLB to a new task, `on_publish` fires again, and the API sends an `ingest_relocated` message so the worker reconnects. Redis-based registry is a future option for added resilience.
- **SQS FIFO** per-user message group prevents race conditions on start/stop/relocate commands
- **Redis TTL on stream state** — if a worker crashes without cleanup, state expires and API reconciles on next poll
- **RTMP ingest rate limiting**:
  - **One active stream per stream key** — `on_publish` handler rejects if the key already has an active session (checked via Redis)
  - **Reconnect throttle** — Redis counter with TTL enforces a cooldown (e.g. 5s) between disconnect and reconnect for the same stream key, preventing flapping
  - **Infrastructure-level cap** — bounded ingest ECS desired count + max connections per NLB target group caps total concurrent streams
- **Graceful stream handoff during deploys**:
  - NLB target group deregistration delay set high (300s) to allow active connections to drain
  - Ingest container handles SIGTERM by notifying the API before shutdown, which triggers `ingest_relocated` messages to workers — same path as unplanned failover
  - ECS rolling deploy ensures new ingest tasks are healthy before old tasks begin draining
- **Output destination failure monitoring**:
  - Worker classifies FFmpeg exit codes/stderr — user errors (rejected key, auth failure) are surfaced in the UI; transient errors (timeout, connection reset) trigger auto-retry
  - CloudWatch alarm on sustained output error rate — if an output stays in `error` state >2 minutes after retries, fire SNS notification
  - Destination-specific error messages logged and visible on the `/logs` page for self-service debugging
- **Aurora failover and resilience**:
  - Aurora Serverless v2 Multi-AZ with automatic failover (~30s) — enabled by default
  - Prisma connects via the **cluster endpoint** so failover is transparent to the application
  - API connection retry logic handles the brief disconnect during failover (Prisma `pool_timeout` + application-level retry)
  - Automatic backups with 35-day retention

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
