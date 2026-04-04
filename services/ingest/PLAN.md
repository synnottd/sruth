# Ingest Service — Implementation Plan

## Overview

Receives RTMP streams from OBS/streaming clients and authenticates them via the API before handing off to workers.

```
OBS / streaming client
        │ RTMP (port 1935)
        ▼
[NLB (TCP)] → [Ingest Service — nginx-rtmp on ECS Fargate]
                      │ on_publish → HTTP POST to API (auth + fetch outputs)
                      │ on_publish_done → HTTP POST to API (mark ended)
                      ▼
              stream available at rtmp://{ingest-task-ip}/live/{stream_key}
                      │
              [Worker Service pulls from here via FFmpeg]
```

---

## Ingest URL Format

```
rtmp://ingest.omega-stream.io/live/{stream_key}
```

- `{stream_key}` is unique per user, generated on registration, rotatable
- The NLB routes TCP/1935 to any healthy ingest ECS task (multi-AZ)

---

## nginx-rtmp Configuration

### Core responsibilities

- Accept incoming RTMP connections on port 1935
- Fire `on_publish` HTTP callback to API when a stream starts
- Fire `on_publish_done` HTTP callback to API when a stream ends
- Make the live stream available internally at `rtmp://{task-ip}:1935/live/{stream_key}` for workers to pull from
- Reject streams whose `on_publish` callback returns non-2xx (invalid/unknown key)
- Fail closed: if the API is unreachable, `on_publish` returns non-2xx and the stream is rejected — no unauthenticated streams are ever allowed through

### nginx.conf sketch

```nginx
worker_processes auto;
rtmp_auto_push on;  # Required: shares stream data across workers so subscribers on any worker receive data
error_log /dev/stderr warn;

rtmp {
    server {
        listen 1935;
        chunk_size 4096;

        application live {
            live on;
            record off;  # Explicit decision — no recording at ingest layer. DVR/replay deferred (see PLAN-FUTURE.md)

            # Auth callback — nginx sends stream key in the POST body
            # API returns 2xx to allow, non-2xx to reject
            # Fail closed: API down = no streams accepted
            notify_method post;
            on_publish http://${API_HOST}/internal/stream/on-publish;
            on_publish_done http://${API_HOST}/internal/stream/on-publish-done;

            # Workers pull directly via RTMP — no HLS/DASH relay
        }
    }
}

http {
    server {
        listen 8080;

        location /stat {
            rtmp_stat all;
            rtmp_stat_stylesheet stat.xsl;
        }

        location /health {
            return 200 "ok\n";
        }
    }
}
```

Note: This is a template (`nginx.conf.template`). `${API_HOST}` is substituted at container startup via `envsubst` in `docker-entrypoint.sh`, allowing the API endpoint to be configured per environment without rebuilding the image. The nginx config includes the `http://` scheme as a literal prefix — `API_HOST` should be `host:port` only.

### on_publish callback

nginx-rtmp POSTs form-encoded data to the API:

```
POST /internal/stream/on-publish
Content-Type: application/x-www-form-urlencoded

app=live&name={stream_key}&addr={client_ip}&...
```

API behaviour:
- Looks up `stream_key` in DB — 401 if not found/disabled
- Checks Redis for an existing active session for this key — 409 if already live (prevents duplicate streams)
- Applies reconnect throttle: Redis counter with TTL (`RECONNECT_COOLDOWN_MS`, default 3000ms) between disconnect and reconnect for the same key
- Creates a `StreamSession` record in DB
- Records the ingest task IP in Redis using the **source IP of the HTTP callback** — with Fargate `awsvpc` networking, internal VPC traffic is not NATed, so the source IP is the task's private ENI IP: `stream:{streamKey}:ingest_ip`
- Sets a TTL on the active session key (6 hours) as a safety net in case `on_publish_done` never fires (nginx crash, task kill)
- Sends SQS `stream.start` message to worker with `{ sessionId, userId, outputs[], ingestIp }` using deduplication ID `{sessionId}-start`
- Returns 200 to allow, non-2xx to reject

### on_publish_done callback

```
POST /internal/stream/on-publish-done
Content-Type: application/x-www-form-urlencoded

app=live&name={stream_key}&...
```

API behaviour:
- Marks `StreamSession.endedAt`
- Sends SQS `stream.stop` message to worker using deduplication ID `{sessionId}-stop`
- Clears Redis state for the stream key

Note: `on_publish_done` is not guaranteed to fire (nginx crash, ECS task kill). The Redis TTL on the active session key is the safety net — a stuck key unblocks itself automatically without manual intervention. See PLAN-FUTURE.md for a more robust heartbeat-based approach.

---

## Docker Image

### Dockerfile

```dockerfile
FROM tiangolo/nginx-rtmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Graceful stream handoff on deploy is deferred (see PLAN-FUTURE.md)
# The NLB 300s deregistration delay keeps TCP connections alive during drains;
# OBS reconnects automatically to a new ingest task via NLB

HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD curl -sf http://localhost:8080/health || exit 1

EXPOSE 1935 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
```

`docker-entrypoint.sh` runs `envsubst` to substitute `${API_HOST}` into the nginx config, then `exec`s nginx (so nginx is still PID 1).

Base image: `tiangolo/nginx-rtmp` — Debian-based, stable. `gettext-base` provides `envsubst`. The directives used (`on_publish`, `on_publish_done`) are core to the nginx-rtmp-module spec.

---

## ECS Fargate Deployment

### Task definition

| Parameter | Value |
|---|---|
| CPU | 512 (0.5 vCPU) — nginx is not CPU-bound; scale horizontally |
| Memory | 1024 MB |
| Network mode | `awsvpc` |
| Ports | 1935 (RTMP), 8080 (HTTP health) |
| Environment | `API_HOST` — internal API host:port (no scheme) |
| Environment | `RECONNECT_COOLDOWN_MS` — reconnect throttle in ms (default: 3000) |

### Service configuration

- **Desired count**: 2 minimum (multi-AZ, one per AZ)
- **Warm pool**: keep N idle tasks running (N = `max(2, active_streams * 0.1)`) to absorb new connections without cold start
- **Auto-scaling**: deferred — fixed desired count for MVP (see PLAN-FUTURE.md)
- **Deployment**: rolling update; `deregistrationDelay` on NLB target group set to **300s** so active RTMP connections drain before old tasks are killed
- **On deploy**: active streams drop briefly; OBS reconnects via NLB to a new task; `on_publish` fires on the new task and the worker starts fresh

### ECS service connect / service discovery

- Workers need to pull from a specific ingest task IP (not the NLB), so the API must track and return the per-task private IP
- The ingest task IP is captured from the source IP of the `on_publish` HTTP callback — with Fargate `awsvpc` networking, internal VPC traffic is not NATed, so the source IP is the task's private ENI IP
- Stored in Redis: `stream:{streamKey}:ingest_ip = {task_private_ip}`

---

## Network Load Balancer

| Setting | Value |
|---|---|
| Scheme | Internet-facing |
| Protocol | TCP |
| Port | 1935 |
| Health check | HTTP `/health` on port 8080 |
| Cross-zone load balancing | Enabled |
| Elastic IPs | One per AZ (static IPs for DNS / firewall allowlisting) |
| Deregistration delay | 300s (allow RTMP streams to drain) |

NLB forwards raw TCP — no TLS termination for RTMP (RTMPS is a future option — see PLAN-FUTURE.md).

---

## Rate Limiting & Abuse Prevention

| Concern | Mechanism |
|---|---|
| Duplicate active stream for same key | Redis check in `on_publish` handler — reject if key already active |
| Reconnect flapping | Redis counter + TTL (`RECONNECT_COOLDOWN_MS`, default 3s) in `on_publish` handler |
| Stuck active session (on_publish_done missed) | Redis TTL on active session key (6 hours) — auto-expires without manual intervention |
| API unavailable | Fail closed — `on_publish` returns non-2xx, stream rejected |
| Total concurrent stream cap | NLB target group max connections + ECS desired count ceiling |
| Unknown stream keys | API rejects `on_publish` with non-2xx → nginx drops connection |

---

## Observability

### Metrics

- **ConnectionsAccepted / ConnectionsRejected** — incremented in the `on_publish` API handler, emitted to CloudWatch
- **StreamDuration** — emitted on `on_publish_done`

Note: `ActiveConnections` metric and auto-scaling based on it are deferred — see PLAN-FUTURE.md.

### Logs

- nginx access log → CloudWatch Logs (`/omega-stream/ingest/access`)
- nginx error log → CloudWatch Logs (`/omega-stream/ingest/error`)
- `on_publish`/`on_publish_done` outcomes logged in API service

### Alarms

- nginx error log contains repeated `on_publish` failures → SNS alert

---

## Local Development (docker-compose)

```yaml
services:
  ingest:
    build: .
    ports:
      - '1935:1935'
      - '8080:8080'
    environment:
      API_HOST: mock-api:3001
    depends_on:
      mock-api:
        condition: service_healthy

  mock-api:
    build: ./test/mock-api
    ports:
      - '3001:3001'
    healthcheck:
      test: ['CMD', 'wget', '-q', '-O-', 'http://localhost:3001/health']
      interval: 2s
      timeout: 3s
      retries: 15
```

The mock-api is a lightweight Node.js server that stubs the `on_publish`/`on_publish_done` endpoints with configurable responses, allowing tests to exercise accept/reject/callback behaviour without the real API.

Test flow:
1. `docker compose up` from `services/ingest/`
2. Point OBS to `rtmp://127.0.0.1:1935/live/{stream_key}` (use `127.0.0.1`, not `localhost`, to avoid IPv6 issues on macOS)
3. Confirm `on_publish` fires in mock-api logs
4. Verify playback: `ffplay rtmp://127.0.0.1:1935/live/{stream_key}`

Automated tests (`pnpm test`) use vitest with a global setup that starts/stops the compose stack, pushing test streams via ffmpeg and probing the nginx-rtmp stat page.

---

## Files

```
services/ingest/
├── Dockerfile
├── docker-compose.yml       # local dev / test compose stack
├── docker-entrypoint.sh     # envsubst + exec nginx
├── nginx.conf.template      # nginx config with ${API_BASE_URL} placeholder
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── PLAN.md                  # this file
├── PLAN-FUTURE.md           # deferred work
└── test/
    ├── global-setup.ts      # starts/stops docker compose for tests
    ├── callbacks.test.ts    # on_publish / on_publish_done lifecycle
    ├── stream-accept.test.ts
    ├── stream-reject.test.ts
    ├── stream-passthrough.test.ts  # end-to-end: push stream, verify it's playable
    ├── helpers/
    │   └── rtmp.ts          # ffmpeg push/probe utilities
    └── mock-api/
        ├── Dockerfile
        └── server.mjs       # configurable stub for on_publish callbacks
```
