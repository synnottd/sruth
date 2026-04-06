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
   - `stop` — tear down all FFmpeg processes for a session (or a single output if `outputSessionId` is provided)
   - `update` — add/remove output destinations mid-stream (API creates `OutputSession` records before sending; worker only manages processes and Redis)
   - `ingest_relocated` — tear down FFmpeg processes and reconnect to a new ingest IP

2. **FFmpeg Process Manager** — for each output destination:
   - Spawn FFmpeg: pull from `rtmp://{ingestIP}:1935/live/{streamKey}` (port `1935` and app `live` are hardcoded constants — they match the ingest nginx config and only change via coordinated deploys)
   - Push to output: `ffmpeg -i rtmp://{ingestIP}:1935/live/{streamKey} -c copy -f flv -progress pipe:1 rtmp://{destUrl}/{destKey}`
   - Note: no `-reconnect` flags — those only work with HTTP inputs, not RTMP. Reconnection is handled by process-level retry.
   - Use `-progress pipe:1` for structured key=value metrics on stdout; stderr is reserved for error messages and logs
   - Parse `-progress` output: extract `bitrate`, `speed`, `drop_frames` from key=value pairs between `progress=continue` markers
   - Supervise processes: on crash, retry with **exponential backoff (5 retries: 1s, 2s, 4s, 8s, 16s = ~31s total)**. During retries, output status is `retrying`. After exhausting retries, mark output as `error` in Redis (visible in UI)
   - Same retry/backoff logic applies to initial connection failures on `start`
   - Each output's retry loop uses an **AbortController** with cancellable sleeps — `ingest_relocated` aborts all controllers, updates the ingest IP, and restarts outputs with fresh retry counters

3. **Health Reporting** — publish stream health metrics:
   - **Buffer locally, flush to Redis every 5 seconds** — parse `-progress` stdout for `bitrate`, `speed`, `drop_frames`; keep latest values in memory; write to Redis on 5s interval
   - **CloudWatch Metrics** — push bitrate samples once per minute with StatisticValues (min/max/sum/count aggregated from 5s in-memory samples). Namespace: `OmegaStream/Worker`, metric: `Bitrate`, dimensions: `SessionId` + `OutputSessionId`, standard resolution (60s)

4. **Log Capture** — FFmpeg stderr per output:
   - Read stderr line-by-line via Node `readline` interface on the child process stderr stream
   - For each line, dual-write:
     - **Redis list** (LPUSH + LTRIM to 200 lines, 300s TTL) for real-time tailing via `/logs` SSE endpoint
     - **CloudWatch Logs** via `PutLogEvents` — buffer in memory, flush every 5s or 50 lines (whichever first). Log group: `/omega-stream/worker/ffmpeg`, log stream: `{sessionId}/{outputSessionId}`
   - Worker application logs (SQS received, session started, FFmpeg spawned, retry triggered) go to stdout → ECS awslogs driver → CloudWatch Logs

5. **Error Classification** — classify FFmpeg stderr patterns:
   - **User errors** — stderr matches: `Authorization failed`, `Authentication`, `403` → surface in UI, no retry
   - **Transient errors** — stderr matches: `Connection refused`, `Connection timed out`, `Connection reset`, `Broken pipe` → auto-retry with backoff, status `retrying`
   - **Fatal errors** — everything else → mark `error`, no retry
   - Error alarm: worker publishes an `OutputErrorDuration` metric to CloudWatch. CDK infra defines a CloudWatch Alarm on this metric with a 2-minute threshold → fires SNS notification

6. **Worker Identity & Session Ownership** — multi-worker routing:
   - **Worker ID**: read from ECS container metadata endpoint (`$ECS_CONTAINER_METADATA_URI_V4`). Falls back to a generated UUID in local dev
   - **Heartbeat**: write `worker:{workerId}:heartbeat` to Redis with 30s TTL, refresh every 10s
   - **Session registration**: on `start`, write `session:{sessionId}:worker → {workerId}` to Redis
   - **Message routing**: SQS delivers to any worker. If the receiving worker doesn't own the session, it publishes the command to the owner's Redis pub/sub channel (`worker:{workerId}:commands`). Each worker subscribes to its own channel
   - **Dead owner detection**: if the owner's heartbeat key has expired, the receiving worker claims the orphan — cleans up Redis state, and for `stop` confirms cleanup. For `update`/`relocate`, drops the message (session is gone)
   - **Worker never writes to the database** — it only reads from SQS and writes to Redis. The API is the sole owner of DB state and reconciles on Redis TTL expiry

---

## In-Memory State

```typescript
// Map<sessionId, Session>
interface Session {
  sessionId: string
  userId: string
  streamKey: string
  ingestIP: string
  outputs: Map<string, OutputProcess>  // keyed by outputSessionId
}

interface OutputProcess {
  outputSessionId: string
  rtmpUrl: string
  streamKey: string
  process: ChildProcess
  abortController: AbortController  // cancels retry sleep on ingest_relocated
  retryCount: number
  status: 'starting' | 'live' | 'retrying' | 'error' | 'stopped'
}
```

- All maps keyed by `outputSessionId` (not `outputId`) — direct correlation with DB `OutputSession` records
- O(1) lookup by `sessionId` for all SQS commands
- On `ingest_relocated`: abort all output AbortControllers, update `session.ingestIP`, restart all outputs with new IP and fresh retry counters
- On `update`: add/remove entries in `outputs` map without touching existing running processes

---

## Data Flow

```
API → SQS FIFO (per-user message group) → Worker (any)
                                             │
                                             ├─ Check session ownership via Redis
                                             │    ├─ Owns session → process command
                                             │    └─ Doesn't own → pub/sub to owner's channel
                                             │
                                             ├─ FFmpeg pull from rtmp://{ingestIP}:1935/live/{streamKey}
                                             │    ├─ push to rtmp://twitch.tv/...
                                             │    ├─ push to rtmp://youtube.com/...
                                             │    └─ push to rtmp://custom/...
                                             │
                                             ├─ Health metrics → Redis (every 5s)
                                             ├─ FFmpeg stderr → Redis list (real-time tail)
                                             ├─ FFmpeg stderr → CloudWatch Logs (PutLogEvents, batched)
                                             └─ Bitrate samples → CloudWatch Metrics (every 60s)
```

---

## Key Design Decisions

- **One FFmpeg process per output** (not one FFmpeg with multiple outputs) — isolates failures so one bad destination doesn't affect others. CPU cost of `-c copy` demux is negligible; extra ingest connections are lightweight
- **Multiple sessions per worker task** — FFmpeg `-c copy` is very lightweight (few MB RAM, negligible CPU per output). A single 0.5 vCPU / 1GB Fargate task handles 20-50 outputs. Scale on CPU/memory thresholds (e.g. 60%), not 1:1 with streams. Eliminates warm pool sentinel complexity
- **No `-reconnect` flags** — these only work with HTTP inputs, not RTMP. Reconnection is handled entirely by process-level retry with exponential backoff
- **`-progress pipe:1`** for metrics — structured key=value output, trivially parseable, separates metrics (stdout) from errors (stderr). Extract only `bitrate`, `speed`, `drop_frames`
- **5s Redis flush interval** — balances near-real-time dashboard updates with manageable write volume. Two missed flushes before TTL expiry (10s bitrate key) gives clean "worker is gone" signal
- **SQS FIFO** with per-user message group prevents race conditions on start/stop/relocate commands
- **Redis pub/sub for message routing** — SQS doesn't have consumer affinity. Workers check session ownership via Redis and re-route commands to the correct owner via per-worker pub/sub channels
- **AbortController for retry interruption** — `ingest_relocated` can cancel in-progress backoff sleeps instantly rather than waiting for the current delay to elapse
- **`-c copy` passthrough** — no transcoding, minimal CPU, just remuxes the stream
- **Redis TTL on stream state** — if a worker crashes without cleanup, state expires and API reconciles on next poll
- **Worker doesn't write to the database** — it only reads from SQS and writes to Redis. The API is the sole owner of DB state
- **`outputSessionId` everywhere** — in-memory maps, Redis hash fields, SQS messages, and CloudWatch log streams all use `outputSessionId` for direct DB correlation
- **Stderr pattern matching for error classification** — simple regex-based detection, easy to extend. No reliance on FFmpeg exit codes (poorly standardized)
- **`retrying` status** — distinct from `starting` and `error`, lets the UI show a yellow warning state with retry count during backoff

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

**Open questions** — see GitHub issues:
- [#17](https://github.com/synnottd/omega-stream/issues/17) — SQS batch conflict handling (start+stop in same batch)
- [#18](https://github.com/synnottd/omega-stream/issues/18) — Redelivery delay for unprocessed messages on shutdown

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
    { "outputSessionId": "uuid", "rtmpUrl": "rtmp://live.twitch.tv/app", "streamKey": "live_xxx" }
  ]
}
```

### `stop`
```json
{
  "type": "stop",
  "sessionId": "uuid",
  "outputSessionId": "uuid (optional — omit to stop all)"
}
```

### `update`
```json
{
  "type": "update",
  "sessionId": "uuid",
  "addOutputs": [{ "outputSessionId": "uuid", "rtmpUrl": "...", "streamKey": "..." }],
  "removeOutputSessionIds": ["uuid"]
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
| `stream:{sessionId}:status` | hash | 120s | Per-output status, keyed by `outputSessionId` (`live`, `retrying`, `error`, `stopped`) |
| `stream:{sessionId}:health` | hash | 30s | Dropped frames, reconnect count per output, keyed by `outputSessionId` |
| `stream:{sessionId}:logs:{outputSessionId}` | list (capped 200) | 300s | FFmpeg stderr for real-time `/logs` tail |
| `session:{sessionId}:worker` | string | 120s | Worker ID that owns this session (refreshed on health flush) |
| `worker:{workerId}:heartbeat` | string | 30s | Worker liveness (refreshed every 10s) |

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

Output removal mid-stream (`update` with `removeOutputSessionIds`) uses the same pattern: SIGTERM with 5s timeout, then SIGKILL.

---

## Dependencies

| Dependency | Purpose |
|---|---|
| `@aws-sdk/client-sqs` | Consume commands from API |
| `@aws-sdk/client-cloudwatch` | Publish bitrate metrics |
| `@aws-sdk/client-cloudwatch-logs` | Publish FFmpeg stderr logs |
| `ioredis` | Real-time state, metrics, log tail, pub/sub routing |
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

### Step 2 — Worker Identity & Routing
- Read worker ID from ECS metadata endpoint (UUID fallback for local dev)
- Subscribe to Redis pub/sub channel `worker:{workerId}:commands`
- Heartbeat: write `worker:{workerId}:heartbeat` every 10s with 30s TTL
- On SQS message for unknown session: check `session:{sessionId}:worker` in Redis, publish to owner's channel (or claim orphan if heartbeat expired)

### Step 3 — FFmpeg Process Manager
- Spawn FFmpeg child processes: `ffmpeg -i rtmp://{ingestIP}:1935/live/{streamKey} -c copy -f flv -progress pipe:1 rtmp://{destUrl}/{destKey}`
- Track in `Map<string, Session>` with nested `Map<string, OutputProcess>` (keyed by `outputSessionId`)
- Each output gets an AbortController for cancellable retry sleeps
- Read stdout line-by-line for `-progress` key=value pairs (accumulate between `progress=continue` markers, extract `bitrate`, `speed`, `drop_frames`)
- Handle process exit: classify stderr patterns, retry with exponential backoff (5 retries: 1s, 2s, 4s, 8s, 16s), set status `retrying` during backoff, mark `error` after exhaustion
- Same retry path for initial connection failures on `start`

### Step 4 — Health Reporting
- Buffer latest `-progress` stats in memory per output
- Flush to Redis every 5 seconds (bitrate, status, health keys with TTL)
- Push bitrate samples to CloudWatch every 60s with StatisticValues (namespace: `OmegaStream/Worker`, dimensions: `SessionId`, `OutputSessionId`)

### Step 5 — Log Capture
- Pipe FFmpeg stderr per output via Node `readline` interface to:
  - Redis list (LPUSH + LTRIM to 200 lines) for real-time tail
  - CloudWatch Logs via PutLogEvents (buffer in memory, flush every 5s or 50 lines). Log group: `/omega-stream/worker/ffmpeg`, stream: `{sessionId}/{outputSessionId}`
- Worker application logs to stdout

### Step 6 — Session Lifecycle
- `start`: register `session:{sessionId}:worker` in Redis, create `Session` in map, spawn FFmpeg per output, begin health reporting
- `stop`: SIGTERM all FFmpeg for session (or single output if `outputSessionId` provided), clean up Redis, remove from map
- `update`: add new FFmpeg processes for `addOutputs`, SIGTERM (5s timeout) + remove for `removeOutputSessionIds`; existing outputs untouched
- `ingest_relocated`: abort all output AbortControllers, update `ingestIP`, re-spawn all outputs with new IP and fresh retry counters

### Step 7 — Error Handling & Resilience
- Classify FFmpeg errors via stderr pattern matching: user (no retry) vs transient (retry) vs fatal (no retry)
- Exponential backoff: 1s, 2s, 4s, 8s, 16s with AbortController-cancellable sleeps
- SIGTERM shutdown sequence (see Graceful Shutdown section)
- DLQ: `maxReceiveCount: 3`, CloudWatch alarm on depth > 0, 14-day retention
- Publish `OutputErrorDuration` metric for CDK-defined CloudWatch alarm (>2 min → SNS)

### Step 8 — Integration Testing
- Docker Compose stack:
  - **nginx-rtmp** (ingest) — accepts test streams
  - **Redis** — real instance for health/log/pub-sub verification
  - **ElasticMQ** — lightweight SQS FIFO mock (single JAR, ~50MB image)
  - **Second nginx-rtmp instance** (test sink on port 1936) — verifies stream arrives at destination
  - **FFmpeg** on host — real processes
- Tests (vitest, same pattern as ingest service):
  - `start` message → FFmpeg spawns → stream reaches test sink → Redis health keys populated
  - `stop` message → FFmpeg killed → Redis cleaned up
  - `ingest_relocated` → FFmpeg restarted with new source
  - Output failure → retry with backoff → `retrying` status → `error` state after max retries
  - Graceful shutdown → FFmpeg processes terminated → Redis updated
  - Message routing → wrong worker re-routes via pub/sub → correct worker processes

---

## Local Development

- **SQS**: ElasticMQ in root `docker-compose.yml` (port 9324). Worker connects via `SQS_ENDPOINT=http://localhost:9324`
- **CloudWatch**: stubbed with no-op implementations behind `LOCAL_DEV=true` env flag (metrics and logs silently dropped)
- **Redis**: real instance from root `docker-compose.yml`
- **FFmpeg**: must be installed on host (`brew install ffmpeg` on macOS)
- Send test messages via AWS CLI pointed at ElasticMQ: `aws sqs send-message --endpoint-url http://localhost:9324 ...`

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

- **Local**: `docker-compose up` → send test SQS message via ElasticMQ → verify FFmpeg spawns and pushes to test RTMP sink (`rtmp://localhost:1936/live/output1`)
- **Unit tests**: FFmpeg argument construction, error classification, SQS message parsing, retry logic, stderr pattern matching
- **Integration tests**: Full flow with real nginx-rtmp + ElasticMQ + Redis + real FFmpeg (see Step 8)
