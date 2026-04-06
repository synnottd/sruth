# Ingest Service — Deferred / Future Work

Items explicitly cut from MVP. Revisit once the core flow is proven.

## Graceful stream handoff on deploy

On SIGTERM, notify the API before nginx stops so workers can reconnect proactively rather than hitting an FFmpeg error and recovering after the fact.

Requires a wrapper script as PID 1 that traps SIGTERM, POSTs to `POST /internal/ingest/shutting-down?taskIp={ip}` synchronously, waits for a 200, then forwards SIGTERM to nginx. The API sends `ingest_relocated` SQS messages to all workers with active sessions on that task — same code path as unplanned failover.

Cut because: NLB 300s deregistration delay + OBS auto-reconnect is sufficient for MVP. Shell signal handling is fiddly and hard to test without a real ECS deploy.

## Auto-scaling on ActiveConnections

Step scaling policy based on an `ActiveConnections` CloudWatch custom metric.

Requires a stat scraper sidecar in the ECS task that polls `localhost:8080/stat` (nginx-rtmp XML), parses it, and calls `put-metric-data` every 30s.

Cut because: fixed desired count is fine until real traffic data exists to size against.

## RTMPS (TLS)

Separate NLB listener on TCP/443 (or dedicated RTMPS port) for encrypted ingest.

Cut because: out of scope for MVP. Note the NLB listener config change needed when this is added.

## DVR / Replay

Record streams at the ingest layer and store segments to S3.

`record off` in nginx.conf is an explicit decision, not an oversight. Adding DVR means changing this directive and wiring up an S3 upload path.

## Worker heartbeat reconciliation

Currently, missed `on_publish_done` callbacks (nginx crash, task kill) are handled by a Redis TTL on the active session key (6 hours). This means a stuck key unblocks itself eventually but `StreamSession.endedAt` is never set and the worker never gets a clean `stream.stop`.

A more robust approach: worker writes a keepalive to Redis every 30s; API reconciliation job treats a missing heartbeat as an ended session and cleans up DB + sends `stream.stop`.

Cut because: TTL-only is sufficient for MVP. A 6-hour stuck session is an acceptable edge case.
