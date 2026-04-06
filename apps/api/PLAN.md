# API Service — Implementation Plan

## Overview

**Node.js + TypeScript** with **Fastify** (better performance than Express, native TypeScript support), **Prisma ORM** + **Aurora PostgreSQL Serverless v2**, **Redis (ElastiCache)** for live stream state (active streams, health metrics, current status).

---

## REST Endpoints

### Public (no auth)
- `POST /auth/register` — create account, returns access token + refresh cookie + stream key
- `POST /auth/login` — returns access token + refresh cookie
- `POST /auth/refresh` — exchange refresh cookie for new token pair

### Authenticated (JWT required)
- `GET /outputs` — list user's output destinations
- `POST /outputs` — create output destination
- `PUT /outputs/{id}` — update output destination
- `DELETE /outputs/{id}` — delete output destination
- `GET /stream` — get user's ingest URL + stream key
- `POST /stream/key/rotate` — rotate stream key (blocked while live — 409)
- `GET /streams/active` — list currently live outputs with health metrics
- `POST /streams/{outputId}/stop` — stop a single output (no cascade, no mid-stream restart)

### Internal (VPC-only, no auth)
- `POST /internal/stream/on-publish` — nginx-rtmp callback on stream start
- `POST /internal/stream/on-publish-done` — nginx-rtmp callback on stream end

### Deferred
- `GET /streams/logs/{outputId}` — FFmpeg log tailing. Requires a log forwarding pipeline (worker → Redis/CloudWatch → API). Deferred until the web UI is ready to consume it.

---

## Server Structure

Fastify plugin registration order (encapsulation matters):

```
1. prisma plugin     → decorates fastify with `prisma` (with soft-delete client extension)
2. redis plugin      → decorates fastify with `redis` (ioredis)
3. @fastify/jwt      → decorates with `jwtSign` / `jwtVerify`
4. auth plugin       → decorates with `authenticate` preHandler
5. zod type provider → fastify-type-provider-zod for request/response validation
6. public routes     → /auth/* (no authenticate preHandler)
7. internal routes   → /internal/* (no authenticate — secured by VPC-only ALB routing)
8. authenticated routes → /outputs, /stream, /streams (authenticate preHandler)
```

### Error Response Format

All endpoints return errors in a consistent shape:

```json
{
  "statusCode": 401,
  "error": "INVALID_STREAM_KEY",
  "message": "Stream key not found or disabled"
}
```

- `error`: machine-readable uppercase snake_case code — clients switch on this
- `message`: human-readable, safe to show in UI
- Fastify/Zod validation errors use `error: "VALIDATION_ERROR"`

---

## Auth

### JWT Token Design

- **Access token**: 15 minute expiry, payload `{ sub: userId, email }`, stateless (no DB lookup per request), sent in `Authorization: Bearer` header
- **Refresh token**: 7 day expiry, stored as HTTP-only secure cookie, backed by Redis key for revocation
- **Rotation**: each refresh grants a new access + refresh token pair. If a refresh token is reused after rotation, revoke the entire token family
- **Logout**: deletes the current refresh token's Redis key + clears cookie. Does NOT revoke other sessions

### Password Hashing

- `bcryptjs` (pure JS — no native build dependency), 12 salt rounds (~250ms on Fargate 0.5 vCPU)
- Login is not a hot path; swap to native `bcrypt` later if needed (same API)

### Registration

- **Email + password only** — no display name for MVP
- **No email verification for MVP** — add when public signup creates abuse risk
- **Stream key auto-generated on registration** (`crypto.randomUUID()`) — user is immediately ready to stream
- Returns access token + refresh cookie + stream key

### Future: OAuth Providers

OAuth providers (Twitch, Google, etc.) will be added later. The JWT layer sits above the authentication method — access/refresh token mechanics, middleware, and route protection all stay the same. Only change: `User.passwordHash` becomes optional (migration at that time).

---

## Outputs CRUD

### Validation

- `rtmpUrl` must start with `rtmp://` or `rtmps://` (Zod validation)
- `platform` must be one of `TWITCH | YOUTUBE | FACEBOOK | CUSTOM`
- **No platform presets for MVP** — user provides both URL and stream key for all platforms. Presets are a UI convenience to add in the web app later
- **Max 5 outputs per user** — prevents unbounded FFmpeg processes. Enforced via DB count query on create

### Stream Key Rotation

- `POST /stream/key/rotate` generates a new `crypto.randomUUID()` stream key
- **Blocked while live** — if Redis shows an active session for the user's current stream key, return 409
- User must disconnect OBS, rotate, then reconnect

---

## Ingest Callbacks

Secured by VPC-only ALB routing — no application-level auth.

### on_publish

nginx-rtmp POSTs form-encoded data:

```
POST /internal/stream/on-publish
Content-Type: application/x-www-form-urlencoded

app=live&name={stream_key}&addr={client_ip}&...
```

API behaviour:
1. Look up `stream_key` in DB → 401 if not found/disabled
2. Check Redis `stream:{streamKey}:cooldown` → 429 if reconnecting too fast
3. Check Redis `stream:{streamKey}:active` for existing session:
   - **No active session** → proceed to step 4
   - **Active session, same ingest IP** → 409 (genuine duplicate)
   - **Active session, different ingest IP** → ingest failover: update Redis with new IP, send `ingest_relocated` SQS message, return 200
4. Set Redis `stream:{streamKey}:cooldown` with 3s TTL
5. Create `StreamSession` record in DB (status: STARTING)
6. Create `OutputSession` records for each enabled output
7. Set Redis `stream:{streamKey}:active = sessionId` with 6-hour TTL
8. Set Redis `stream:{streamKey}:ingest_ip = {callback source IP}` with 6-hour TTL
9. Send SQS `stream.start` message with `{ sessionId, userId, outputs[], ingestIp }`, deduplication ID `{sessionId}-start`
10. Return 200

### on_publish_done

```
POST /internal/stream/on-publish-done
Content-Type: application/x-www-form-urlencoded

app=live&name={stream_key}&...
```

API behaviour:
1. Mark `StreamSession.endedAt` and status → STOPPED
2. Mark all associated `OutputSession` records as STOPPED
3. Send SQS `stream.stop` message, deduplication ID `{sessionId}-stop`
4. Delete Redis keys: `stream:{streamKey}:active`, `stream:{streamKey}:ingest_ip`

Note: `on_publish_done` is not guaranteed to fire (nginx crash, ECS task kill). The 6-hour Redis TTL is the safety net.

---

## SQS Integration

- **Single FIFO queue** for all command types (start, stop, update, ingest_relocated)
- **`MessageGroupId = userId`** — guarantees per-user ordering (start→stop→start processed in sequence), while different users' commands are independent and processed in parallel
- Workers dispatch on the `type` discriminator from the shared package types
- Deduplication IDs: `{sessionId}-{commandType}`

---

## Redis Key Schema

| Key | Value | TTL | Purpose |
|---|---|---|---|
| `stream:{streamKey}:active` | `sessionId` | 6 hours | Active session guard + duplicate check |
| `stream:{streamKey}:ingest_ip` | task private IP | 6 hours | Worker pulls RTMP from this IP |
| `stream:{streamKey}:cooldown` | `1` | 3 seconds | Reconnect throttle |
| `refresh:{userId}:{tokenId}` | `1` | 7 days | Revocable refresh token |
| `stream:{sessionId}:bitrate` | JSON health blob | 30 seconds | Real-time metrics from worker |

---

## Soft Deletes

- `User` and `Output` models have `deletedAt` columns
- **Prisma client extension** auto-appends `where: { deletedAt: null }` to `findMany`, `findFirst`, `findUnique`, `count`, and `update` queries on these models
- `StreamSession` and `OutputSession` have no soft delete
- For future admin queries on deleted records: use raw queries or a second Prisma client without the extension

---

## Streams Monitoring

### GET /streams/active

- Query DB for user's active `StreamSession` + associated `OutputSessions`
- Enrich with real-time metrics from Redis (`stream:{sessionId}:bitrate`)
- DB is source of truth for what's active; Redis provides live numbers

### POST /streams/{outputId}/stop

- Stops a **single output** only — no "stop everything" endpoint (user disconnects OBS for that)
- Marks `OutputSession.status = STOPPED`
- Sends SQS stop command targeting the specific output
- Does **not** cascade to `StreamSession` even if all outputs are stopped
- **No mid-stream restart** — once stopped, stays stopped until next session

---

## Data Model (PostgreSQL via Prisma)

```
User
  id, email, passwordHash, createdAt, deletedAt
  streamKey (unique, rotatable)

Output
  id, userId, name, platform (enum: TWITCH|YOUTUBE|FACEBOOK|CUSTOM)
  rtmpUrl, streamKey, enabled
  createdAt, updatedAt, deletedAt
  @@unique([userId, streamKey])

StreamSession
  id, userId, status (enum: STARTING|LIVE|ERROR|STOPPED)
  startedAt, endedAt, avgBitrate, peakBitrate
  @@index([userId]), @@index([startedAt])

OutputSession
  id, sessionId, outputId
  status (enum: STARTING|LIVE|ERROR|STOPPED)
  lastError, reconnectCount, startedAt, endedAt
  @@index([sessionId]), @@index([outputId])
```

**Stream metrics strategy:**
- **Real-time bitrate**: stored in Redis (`stream:{sessionId}:bitrate`) with 30s TTL, read by dashboard via SSE
- **Time-series history**: worker pushes bitrate samples as CloudWatch custom metrics — gives min/avg/max/p99 with 15-month retention, no extra infrastructure
- **Post-session summary**: on session end, API pulls aggregates from CloudWatch via `GetMetricStatistics` and writes `avgBitrate`/`peakBitrate` to `StreamSession`

---

## Rate Limiting & Abuse Prevention

| Concern | Mechanism |
|---|---|
| Duplicate active stream for same key | Redis check in `on_publish` — reject 409 if key already active from same IP |
| Ingest failover (different IP) | Redis IP comparison in `on_publish` — update IP, send `ingest_relocated` |
| Reconnect flapping | Redis `stream:{streamKey}:cooldown` with 3s TTL |
| Stuck active session (on_publish_done missed) | Redis TTL on active session key (6 hours) |
| API unavailable | Fail closed — `on_publish` returns non-2xx, stream rejected |
| Unknown stream keys | API rejects `on_publish` with 401 → nginx drops connection |
| Output spam | Max 5 outputs per user |

---

## Reliability

- **Aurora Serverless v2** Multi-AZ with automatic failover (~30s)
- Prisma connects via the **cluster endpoint** — failover is transparent
- API connection retry logic handles brief disconnect during failover (Prisma `pool_timeout` + application-level retry)
- Automatic backups with 35-day retention

---

## ECS Fargate Deployment

- Deployed on **ECS Fargate** behind **ALB + HTTPS**
- ALB has two listener rules:
  - **Public**: routes `/auth/*`, `/outputs/*`, `/stream/*`, `/streams/*` — internet-facing
  - **Internal**: routes `/internal/*` — VPC-only, no public access

---

## Local Development (docker-compose)

```yaml
api:
  build: ./apps/api
  ports:
    - "3000:3000"
  environment:
    DATABASE_URL: postgresql://postgres:postgres@db:5432/omega_stream
    REDIS_URL: redis://redis:6379
    JWT_SECRET: dev-secret
    JWT_ACCESS_EXPIRY: 15m
    JWT_REFRESH_EXPIRY: 7d
  depends_on:
    - db
    - redis
```

---

## Implementation Order

1. **Server scaffold** — Fastify entry point, plugins (prisma, redis, auth, zod type provider), error handler
2. **Auth endpoints** — register, login, refresh, logout
3. **Outputs CRUD** — list, create, update, delete with Zod validation + 5-output cap
4. **Stream key management** — get ingest URL, rotate key (with live-stream guard)
5. **Ingest callbacks** — `on_publish` / `on_publish_done` with Redis state management
6. **SQS integration** — send start/stop/update/ingest_relocated commands to workers
7. **Stream monitoring** — `GET /streams/active` (DB + Redis), `POST /streams/{outputId}/stop`

---

## Files to Create

```
apps/api/
├── prisma/
│   └── schema.prisma        # (already exists)
├── src/
│   ├── index.ts             # Fastify server entry point
│   ├── plugins/
│   │   ├── auth.ts          # JWT auth plugin + authenticate preHandler
│   │   ├── prisma.ts        # Prisma client plugin (with soft-delete extension)
│   │   └── redis.ts         # ioredis client plugin
│   ├── routes/
│   │   ├── auth.ts          # POST /auth/register, /auth/login, /auth/refresh, /auth/logout
│   │   ├── outputs.ts       # CRUD /outputs
│   │   ├── stream.ts        # GET /stream, POST /stream/key/rotate
│   │   ├── streams.ts       # GET /streams/active, POST /streams/:outputId/stop
│   │   └── internal/
│   │       └── stream.ts    # on_publish, on_publish_done
│   └── lib/
│       └── sqs.ts           # SQS FIFO client + message helpers
├── package.json             # (already exists)
├── tsconfig.json            # (already exists)
├── Dockerfile
└── PLAN.md                  # this file
```
