# Worker Service — Implementation Plan

Extracted from the root `PLAN.md`, refined through design review.

---

## Overview

Node.js process that manages **FFmpeg** child processes for restreaming. Each worker task handles **multiple sessions** (not 1:1). Spawns one FFmpeg process per output destination using `-c copy` (no transcode — streams are forwarded as-is from ingest).

Worker pulls streams from ingest via RTMP (`rtmp://{ingestIP}:1935/live/{streamKey}`). The ingest nginx-rtmp `live on` + `rtmp_auto_push on` configuration makes streams readable by default — confirmed by ingest service passthrough tests.

---

## Responsibilities

1. **SQS Consumer** — listen on an SQS FIFO queue for commands from the API:
   - `start` — begin restreaming for a user's stream session (includes ingest task IP and list of output destinations)
   - `stop` — tear down all FFmpeg processes for a session
   - `update` — add/remove output destinations mid-stream (API creates `OutputSession` records before sending; worker only manages processes and Redis)
   - `ingest_relocated` — tear down FFmpeg processes and reconnect to a new ingest IP

2. **FFmpeg Process Manager** — for each output destination:
   - Spawn FFmpeg: pull from `rtmp://{ingestIP}:1935/live/{streamKey}` (port `1935` and app `live` are hardcoded constants — they match the ingest nginx config and only change via coordinated deploys)
   - Push to output: `ffmpeg -i {source} -c copy -f flv -progress pipe:1 -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 {destination}`
   - Use `-progress pipe:1` for structured key=value metrics on stdout; stderr is reserved for error messages and logs
   - Supervise processes: on crash, retry with **exponential backoff (5 retries: 1s, 2s, 4s, 8s, 16s = ~31s total)**. After exhausting retries, mark output as `error` in Redis (visible in UI)
   - Same retry/backoff logic applies to initial connection failures on `start` — an `ingest_relocated` message can interrupt the retry loop if the stream moved

3. **Health Reporting** — publish stream health metrics:
   - **Buffer locally, flush to Redis every 5 seconds** — parse `-progress` stdout for `bitrate`, `speed`, `drop_frames`; keep latest values in memory; write to Redis on 5s interval
   - **CloudWatch** — push periodic bitrate samples as custom metrics (min/avg/max/p99, 15-month retention)

4. **Log Capture** — FFmpeg stderr per output:
   - **Redis list** (capped at 200 lines, short TTL) for real-time tailing via `/logs` SSE endpoint
   - **CloudWatch Logs** for durable post-session debugging
   - Worker application logs (SQS received, session started, FFmpeg spawned, retry triggered) go to stdout → CloudWatch Logs agent on ECS

5. **Error Classification** — classify FFmpeg exit codes/stderr:
   - **User errors** (rejected key, auth failure) → surface in UI, no retry
   - **Transient errors** (timeout, connection reset) → auto-retry with backoff
   - **Fatal errors** (unknown) → mark `error`, no retry
   - CloudWatch alarm on sustained output error rate — if an output stays in `error` state >2 minutes after retries, fire SNS notification

---

## In-Memory State

```typescript
// Map<sessionId, Session>
interface Session {
  sessionId: string
  userId: string
  streamKey: string
  ingestIP: string
  outputs: Map<string, OutputProcess>  // keyed by outputId
}

interface OutputProcess {
  outputId: string
  rtmpUrl: string
  streamKey: string
  process: ChildProcess
  retryCount: number
  status: 'starting' | 'live' | 'error' | 'stopped'
}
```

- O(1) lookup by `sessionId` for all SQS commands
- On `ingest_relocated`: update `session.ingestIP`, restart all outputs with new IP
- On `update`: add/remove entries in `outputs` map without touching existing running processes

---

## Data Flow

```
API → SQS FIFO (per-user message group) → Worker
                                             │
                                             ├─ FFmpeg pull from rtmp://{ingestIP}:1935/live/{streamKey}
                                             │    ├─ push to rtmp://twitch.tv/...
                                             │    ├─ push to rtmp://youtube.com/...
                                             │    └─ push to rtmp://custom/...
                                             │
                                             ├─ Health metrics → Redis (every 5s)
                                             ├─ FFmpeg stderr → Redis list (real-time tail)
                                             ├─ FFmpeg stderr → CloudWatch Logs (durable)
                                             └─ Bitrate samples → CloudWatch Metrics (time-series)
```

---

## Key Design Decisions

- **One FFmpeg process per output** (not one FFmpeg with multiple outputs) — isolates failures so one bad destination doesn't affect others. CPU cost of `-c copy` demux is negligible; extra ingest connections are lightweight
- **Multiple sessions per worker task** — FFmpeg `-c copy` is very lightweight (few MB RAM, negligible CPU per output). A single 0.5 vCPU / 1GB Fargate task handles 20-50 outputs. Scale on CPU/memory thresholds (e.g. 60%), not 1:1 with streams. Eliminates warm pool sentinel complexity
- **`-progress pipe:1`** for metrics — structured key=value output, trivially parseable, separates metrics (stdout) from errors (stderr)
- **5s Redis flush interval** — balances near-real-time dashboard updates with manageable write volume. Two missed flushes before TTL expiry (10s bitrate key) gives clean "worker is gone" signal
- **SQS FIFO** with per-user message group prevents race conditions on start/stop/relocate commands
- **`-c copy` passthrough** — no transcoding, minimal CPU, just remuxes the stream
- **Redis TTL on stream state** — if a worker crashes without cleanup, state expires and API reconciles on next poll
- **Worker doesn't write to the database** — it only reads from SQS and writes to Redis. The API is the sole owner of DB state

---

## SQS Configuration

| Setting | Value | Rationale |
|---|---|---|
| `WaitTimeSeconds` | 20 | Max long-poll, reduces empty receives and cost |
| `MaxNumberOfMessages` | 10 | Batch fetch, process sequentially, delete per-message. Saves API round trips |
| `VisibilityTimeout` | 60s | Headroom for FFmpeg spawn + connect. Message reappears after 60s if worker crashes |
| `maxReceiveCount` (redrive) | 3 | DLQ after 3 failures — if it fails 3 times, it won't succeed on a 4th |
| DLQ retention | 14 days | Long enough to investigate after a weekend |
| DLQ alarm | CloudWatch on depth > 0 | Any DLQ message indicates a bug — fire SNS alert |

Messages in the same message group (userId) are delivered in order. Messages across users interleave freely.

---

## SQS Message Schemas

Messages arrive on a FIFO queue with `MessageGroupId` = userId. Schemas defined in `packages/shared/src/sqs.ts`.

### `start`
```json
{
  "type": "start",
  "sessionId": "uuid",
  "userId": "uuid",
  "streamKey": "string",
  "ingestIp": "10.0.1.42",
  "outputs": [
    { "outputId": "uuid", "rtmpUrl": "rtmp://live.twitch.tv/app", "streamKey": "live_xxx" }
  ]
}
```

### `stop`
```json
{
  "type": "stop",
  "sessionId": "uuid"
}
```

### `update`
```json
{
  "type": "update",
  "sessionId": "uuid",
  "addOutputs": [{ "outputId": "uuid", "rtmpUrl": "...", "streamKey": "..." }],
  "removeOutputIds": ["uuid"]
}
```

### `ingest_relocated`
```json
{
  "type": "ingest_relocated",
  "sessionId": "uuid",
  "newIngestIp": "10.0.2.17"
}
```

---

## Redis Keys

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `stream:{sessionId}:bitrate` | string | 10s | Latest bitrate sample for dashboard |
| `stream:{sessionId}:status` | hash | 120s | Per-output status (`live`, `error`, `stopped`) |
| `stream:{sessionId}:health` | hash | 30s | Dropped frames, reconnect count per output |
| `stream:{sessionId}:output:{outputId}:logs` | list (capped 200) | 300s | FFmpeg stderr for real-time `/logs` tail |

---

## Graceful Shutdown (SIGTERM)

ECS stop timeout: **45 seconds**. Shutdown sequence:

1. **Stop polling SQS** — no new messages accepted
2. **Wait for in-flight message handler** to finish (may be mid-spawn)
3. **SIGTERM all FFmpeg child processes** — FFmpeg flushes buffers, closes RTMP connections cleanly
4. **Wait up to 10s for FFmpeg exits**, then SIGKILL stragglers
5. **Update Redis** — set all output statuses to `stopped`, clear health keys
6. **Exit cleanly**

The worker does **not** send SQS stop messages to itself. The API detects worker disappearance via Redis TTL expiry and handles cleanup.

---

## Dependencies

| Dependency | Purpose |
|---|---|
| `@aws-sdk/client-sqs` | Consume commands from API |
| `@aws-sdk/client-cloudwatch` | Publish bitrate metrics |
| `ioredis` | Real-time state, metrics, and log tail |
| `@omega-stream/shared` | Shared types (SQS message schemas, enums) |
| FFmpeg (system binary) | Stream remuxing — installed in Docker image, not an npm dep |

---

## Implementation Steps

### Step 1 — SQS Consumer
- Long-polling consumer loop (`WaitTimeSeconds: 20`, `MaxNumberOfMessages: 10`)
- Parse and validate incoming messages against `@omega-stream/shared` schemas
- Route messages to handler functions by type
- Delete each message after its handler completes (not batch)
- Graceful shutdown on SIGTERM (stop polling, wait for in-flight handler)

### Step 2 — FFmpeg Process Manager
- Spawn FFmpeg child processes: `ffmpeg -i rtmp://{ingestIP}:1935/live/{streamKey} -c copy -f flv -progress pipe:1 -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 rtmp://{destUrl}/{destKey}`
- Track in `Map<string, Session>` with nested `Map<string, OutputProcess>`
- Read stdout line-by-line for `-progress` key=value pairs (accumulate between `progress=continue` markers)
- Handle process exit: classify exit code + stderr, retry with exponential backoff (5 retries: 1s, 2s, 4s, 8s, 16s), mark `error` after exhaustion
- Same retry path for initial connection failures on `start`

### Step 3 — Health Reporting
- Buffer latest `-progress` stats in memory per output
- Flush to Redis every 5 seconds (bitrate, status, health keys with TTL)
- Push periodic bitrate samples to CloudWatch as custom metrics

### Step 4 — Log Capture
- Pipe FFmpeg stderr per output to:
  - Redis list (LPUSH + LTRIM to 200 lines) for real-time tail
  - CloudWatch Logs for durable storage
- Worker application logs to stdout

### Step 5 — Session Lifecycle
- `start`: create `Session` in map, spawn FFmpeg per output, begin health reporting
- `stop`: SIGTERM all FFmpeg for session, clean up Redis, remove from map
- `update`: add/remove individual FFmpeg processes; existing outputs untouched
- `ingest_relocated`: update `ingestIP`, SIGTERM all FFmpeg, re-spawn with new IP

### Step 6 — Error Handling & Resilience
- Classify FFmpeg errors: user (no retry) vs transient (retry) vs fatal (no retry)
- Exponential backoff: 1s, 2s, 4s, 8s, 16s
- SIGTERM shutdown sequence (see Graceful Shutdown section)
- DLQ: `maxReceiveCount: 3`, CloudWatch alarm on depth > 0, 14-day retention

### Step 7 — Integration Testing
- Docker Compose stack:
  - **nginx-rtmp** (ingest) — accepts test streams
  - **Redis** — real instance for health/log verification
  - **ElasticMQ** — lightweight SQS FIFO mock (single JAR, ~50MB image)
  - **Second nginx-rtmp instance** (test sink on port 1936) — verifies stream arrives at destination
  - **FFmpeg** on host — real processes
- Tests (vitest, same pattern as ingest service):
  - `start` message → FFmpeg spawns → stream reaches test sink → Redis health keys populated
  - `stop` message → FFmpeg killed → Redis cleaned up
  - `ingest_relocated` → FFmpeg restarted with new source
  - Output failure → retry with backoff → `error` state after max retries
  - Graceful shutdown → FFmpeg processes terminated → Redis updated

---

## Docker Image

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY dist/ ./dist/
CMD ["node", "dist/index.js"]
```

---

## ECS Fargate Deployment

| Parameter | Value |
|---|---|
| CPU | 512 (0.5 vCPU) |
| Memory | 1024 MB |
| Desired count | 2-3 (multi-AZ) |
| Scaling trigger | CPU or memory > 60% |
| Stop timeout | 45s |
| Network mode | `awsvpc` |

No warm pool sentinel pattern — tasks handle multiple sessions and are always running and polling SQS.

---

## Verification

- **Local**: `docker-compose up` → send test SQS message → verify FFmpeg spawns and pushes to test RTMP sink (`rtmp://localhost:1936/live/output1`)
- **Unit tests**: FFmpeg argument construction, error classification, SQS message parsing, retry logic
- **Integration tests**: Full flow with real nginx-rtmp + ElasticMQ + Redis + real FFmpeg (see Step 7)
