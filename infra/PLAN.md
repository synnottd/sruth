# AWS Infrastructure Plan (CDK) — Test Mode

Extracted from the top-level [PLAN.md](../PLAN.md) — this covers everything needed for `infra/src/`.

**This is the test-mode plan**: a single consolidated Fargate task running all 4 services, optimized for cost and simplicity. Production mode (separate services, NLB, CloudFront, auto-scaling) can be layered on later.

---

## Target Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │                   VPC                        │
                    │                                              │
                    │  Public subnets          Private subnets     │
                    │  ┌────────────────┐      ┌───────────────┐  │
Internet ──────────►│  │  ECS Task      │      │ Aurora PG     │  │
  :3000 (API)       │  │  ┌───────────┐ │      │ (Serverless)  │  │
  :3002 (Web)       │  │  │ API  :3000│ │      └───────────────┘  │
  :1935 (RTMP)      │  │  │ Web  :3002│ │      ┌───────────────┐  │
                    │  │  │Ingest:1935│ │      │ ElastiCache   │  │
                    │  │  │Worker (bg)│ │      │ (Serverless)  │  │
                    │  │  └───────────┘ │      └───────────────┘  │
                    │  └────────────────┘                          │
                    └──────────────────────────────────────────────┘
```

- **Single Fargate task** with 4 containers (API, Web, Ingest, Worker) in a public subnet
- **No ALB** — access services directly via task public IP and port (3000, 3002, 1935)
- **No NLB** — RTMP via task public IP on port 1935
- **No NAT Gateway** — task has public IP for outbound internet access
- **No CloudFront** — direct access
- **No auto-scaling** — single task, `desiredCount: 1`
- **Pausable** — scale to 0 when not testing, ~$2/mo idle cost

---

## Resources

### 1. VPC & Networking

| Resource | Details |
|---|---|
| VPC | 2 AZs, default CIDR `10.0.0.0/16`, CDK defaults |
| Public subnets | 2× `/24`, ECS task (with `assignPublicIp: true`) |
| Private subnets | 2× `/24`, `PRIVATE_ISOLATED` (no NAT), Aurora + ElastiCache |
| NAT Gateway | **None** — task in public subnet has direct internet access |
| ALB | **None** — access task directly by IP:port |

#### Security Groups (all defined in NetworkStack)

| Security Group | Inbound | Outbound |
|---|---|---|
| ECS SG | 3002, 1935 from `0.0.0.0/0` (API on 3000 is internal-only via localhost proxy) | All outbound (internet, Aurora, ElastiCache, SQS) |
| Aurora SG | 5432 from ECS SG | — |
| Redis SG | 6379 from ECS SG | — |

### 2. ECS Cluster & Consolidated Task

Single ECS Fargate cluster, single service, single task definition with 4 containers.

**Task size**: 1 vCPU / 2 GB RAM (shared across all containers)

**Container resource allocation**:

| Container | CPU (units) | Memory (MB) | Rationale |
|---|---|---|---|
| API | 128 | 384 | Lightweight Fastify, low baseline |
| Web | 192 | 512 | Next.js SSR needs memory headroom |
| Ingest | 128 | 256 | nginx-rtmp is efficient |
| Worker | 576 | 896 | FFmpeg dominates CPU; needs memory for transcoding buffers |

**IAM**: Shared execution role (ECR pull + CloudWatch Logs + Secrets Manager read). Single task role with combined permissions:

| Permission | Resource | Consumer |
|---|---|---|
| `sqs:SendMessage` | Worker queue | API |
| `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility` | Worker queue + DLQ | Worker |
| `elasticache:Connect` | ElastiCache cluster | API, Worker |
| `logs:CreateLogStream`, `logs:PutLogEvents` | FFmpeg log group | Worker |
| `cloudwatch:PutMetricData` | `OmegaStream/Worker` namespace | Worker |

**Secrets**: 3 secrets in Secrets Manager, injected via ECS native `secrets` field:

| Secret | Injected into |
|---|---|
| Aurora DB credentials (individual fields: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `DB_NAME`) | API |
| `JWT_SECRET` | API |
| `INTERNAL_SECRET` | API, Ingest |

Aurora credentials are injected as individual fields via `secretStringKey`. The API entrypoint assembles them into `DATABASE_URL` at startup.

**Networking**: All containers share `localhost` — worker reaches ingest at `localhost:1935`, API internal callbacks hit `localhost:3001`.

**Startup ordering**: API starts first. Ingest, Web, and Worker depend on API being healthy (`dependsOn` with `HEALTHY` condition on API's `GET /health` check).

**Deploy strategy**: `minimumHealthyPercent: 0, maximumPercent: 100` (stop-then-start). Brief downtime on redeploy is acceptable for test mode.

#### Container: API (Fastify)
- **Image**: `apps/api` (Dockerfile to be created — multi-stage Node.js build with `prisma generate`)
- **Port**: 3000 (public), 3001 (internal, nginx-rtmp callbacks via localhost)
- **Health check**: `GET /health` on port 3000
- **Essential**: Yes
- **Entrypoint**: Assembles `DATABASE_URL` from injected `DB_*` fields, runs `prisma db push --skip-generate` (swap to `prisma migrate deploy` when migrations are adopted), then starts the app

#### Container: Web (Next.js SSR)
- **Image**: `apps/web` (Dockerfile exists)
- **Port**: 3002 (public)
- **Essential**: Yes
- **API proxy**: `next.config.ts` rewrites `/api/*` to `localhost:3000` — browser only needs the Web container's address, no CORS configuration needed

#### Container: Ingest (nginx-rtmp)
- **Image**: `services/ingest` (Dockerfile exists)
- **Port**: 1935 (RTMP, exposed via task public IP), 8080 (health/stats)
- **Service discovery**: Registers in Redis on startup (same code path as local dev)
- **Essential**: Yes

#### Container: Worker (Node.js + FFmpeg)
- **Image**: `services/worker` (Dockerfile to be created — `node:22-slim` + static FFmpeg binary)
- **No port** — SQS consumer, background processing
- **Essential**: Yes (task restarts if worker crashes — acceptable for test mode)

### 3. Database — Aurora PostgreSQL Serverless v2

| Setting | Value |
|---|---|
| Engine | PostgreSQL 16 |
| Mode | Serverless v2 |
| Multi-AZ | No (single instance — test mode) |
| Min ACU | 0 (auto-pause enabled) |
| Max ACU | 2 |
| Auto-pause timeout | 300s (5 min) |
| Backup retention | Disabled |
| Subnet group | Private subnets |
| Security group | Allow port 5432 from ECS SG |
| Credentials | Secrets Manager (auto-rotated), injected via ECS native secrets |

**Cost**: $0 when idle (auto-pauses to 0 ACU), ~$15s resume latency on first request.

### 4. Cache — ElastiCache Serverless (Valkey)

| Setting | Value |
|---|---|
| Engine | Valkey (Redis OSS compatible) |
| Deployment | ElastiCache Serverless |
| Auth | TLS + IAM auth (required by Serverless) |
| Subnet group | Private subnets |
| Security group | Allow port 6379 from ECS SG |
| Use | Live stream state, health metrics, rate limiting, ingest service discovery |

**Why Serverless over node-based**: No capacity planning, built-in HA (99.99% SLA), pay-per-use pricing (cheaper at low/unpredictable load), TLS+auth by default. Minimum metered storage is 100 MB for Valkey.

**Client code change required**: The `ioredis` clients in API and Worker need a factory that adds TLS + IAM auth token (via `elasticache:Connect`) in AWS, while keeping plain `redis://` connections for local dev. The factory switches on `NODE_ENV` or presence of `REDIS_HOST`. IAM auth tokens last 12 hours; refresh every 10 hours. No local ElastiCache emulator exists — local dev uses plain `redis:7-alpine` in docker-compose.

### 5. Queue — SQS FIFO

| Setting | Value |
|---|---|
| Queue name | `omega-stream-worker.fifo` |
| Content-based dedup | Disabled (use explicit `MessageDeduplicationId`) |
| Message group ID | Per-user (`userId`) to order start/stop/relocate per stream |
| Visibility timeout | 30s |
| DLQ | Separate FIFO queue, `maxReceiveCount: 3` |
| Producers | API container |
| Consumers | Worker container |

### 6. ECR Repositories

- **CDK-managed** with `removalPolicy: RETAIN` (survives `cdk destroy`)
- One repo per service: `ingest`, `worker`, `api`, `web`
- Lives in DataStack alongside other shared resources
- CI pushes images; CDK references by tag via context variable (`-c imageTag=abc123`)

### 7. Secrets Manager

| Secret | Name | Consumers |
|---|---|---|
| Aurora DB credentials | `omega-stream/db-credentials` | API container (individual fields via `secretStringKey`) |
| JWT signing secret | `omega-stream/jwt-secret` | API container |
| Internal service secret | `omega-stream/internal-secret` | API + Ingest containers |

### 8. Logging (CloudWatch)

- **CDK-managed**, 14-day retention, no alarms or dashboards in test mode
- 5 log groups:

| Log Group | Source |
|---|---|
| `/omega-stream/test/api` | API container (ECS `awsLogs` driver) |
| `/omega-stream/test/web` | Web container (ECS `awsLogs` driver) |
| `/omega-stream/test/ingest` | Ingest container (ECS `awsLogs` driver) |
| `/omega-stream/test/worker` | Worker container (ECS `awsLogs` driver) |
| `/omega-stream/worker/ffmpeg` | Worker's `PutLogEvents` for FFmpeg output (streams: `{sessionId}/{outputSessionId}`) |

---

### 9. Resource Naming

| Resource | Name |
|---|---|
| ECS Cluster | `omega-stream` |
| ECS Service | `omega-stream` |
| SQS Queue | `omega-stream-worker.fifo` |
| SQS DLQ | `omega-stream-worker-dlq.fifo` |
| ECR Repos | `omega-stream/api`, `omega-stream/web`, `omega-stream/ingest`, `omega-stream/worker` |
| Log Groups | `/omega-stream/test/*` and `/omega-stream/worker/ffmpeg` |
| Secrets | `omega-stream/db-credentials`, `omega-stream/jwt-secret`, `omega-stream/internal-secret` |

---

## CDK Stack Structure

3 stacks, CloudFormation names: `OmegaStreamNetwork`, `OmegaStreamData`, `OmegaStreamService`.

```
infra/src/
├── app.ts                  # CDK app entry point
├── stacks/
│   ├── network-stack.ts    # VPC, subnets, security groups
│   ├── data-stack.ts       # Aurora, ElastiCache, Secrets Manager, SQS FIFO + DLQ, ECR repos
│   └── service-stack.ts    # ECS cluster + single consolidated task (4 containers)
└── config.ts               # Environment settings
```

**Stack dependencies** (deploy order):
1. `NetworkStack` — no deps
2. `DataStack` — depends on NetworkStack (VPC, subnets, SGs)
3. `ServiceStack` — depends on NetworkStack (SGs, subnets), DataStack (Aurora, Redis, SQS, ECR, Secrets)

---

## Implementation Order

1. **NetworkStack** — VPC, subnets, security groups
2. **DataStack** — Aurora Serverless v2, ElastiCache Serverless, Secrets Manager, SQS FIFO + DLQ, ECR repos
3. **ServiceStack** — ECS cluster, task definition (4 containers), ECS service

---

## Environment Config

```typescript
interface EnvConfig {
  account: string;
  region: string;
  aurora: { minAcu: number; maxAcu: number; autoPauseSeconds?: number };
  taskSize: { cpu: number; memoryMiB: number }; // shared across all containers
  domain?: string;   // undefined = HTTP-only, no ACM cert
  alertEmail?: string;
}

// Test config
const testConfig: EnvConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT!,
  region: 'us-east-1',
  aurora: { minAcu: 0, maxAcu: 2, autoPauseSeconds: 300 },
  taskSize: { cpu: 1024, memoryMiB: 2048 }, // 1 vCPU / 2 GB
};
```

---

## Deployment

- **Image builds**: Manual for now (GitHub Actions later). Helper script `infra/scripts/push-images.sh` builds all 4 Docker images, tags with git SHA, authenticates with ECR, and pushes.
- **Image tagging**: Git short SHA (`git rev-parse --short HEAD`). Traceable to exact commit.
- **Infra deploy**: `cdk deploy --all -c imageTag=<tag>` — manual for now. Only required context variable is `imageTag`.
- **AWS credentials**: Local AWS credentials for manual deploys. Account/region from `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`.
- **Deploy strategy**: Stop-then-start (`minimumHealthyPercent: 0, maximumPercent: 100`). Brief downtime acceptable for test mode.

### First deploy sequence

```bash
# 1. Deploy infra (creates ECR repos, but no images yet)
cdk deploy OmegaStreamNetwork OmegaStreamData

# 2. Build and push images
./infra/scripts/push-images.sh

# 3. Deploy service (references images in ECR)
cdk deploy OmegaStreamService -c imageTag=$(git rev-parse --short HEAD)
```

Subsequent deploys: build+push images, then `cdk deploy OmegaStreamService -c imageTag=<new-tag>`.

### Getting the task IP

After deploy or start, get the task public IP (this is your endpoint for everything):
```bash
# Get task IP
TASK_ARN=$(aws ecs list-tasks --cluster omega-stream --query 'taskArns[0]' --output text)
TASK_IP=$(aws ecs describe-tasks --cluster omega-stream --tasks $TASK_ARN \
  --query 'tasks[0].attachments[0].details[?name==`publicIPv4Address`].value' --output text)
echo "API:   http://$TASK_IP:3000"
echo "Web:   http://$TASK_IP:3002"
echo "RTMP:  rtmp://$TASK_IP:1935/live"
```

**Note**: The IP changes every time the task starts. This is expected for test mode.

---

## Start / Stop (Cost Control)

When not testing, scale the service to 0. Aurora auto-pauses on its own after 5 minutes of inactivity.

```bash
# Stop — Fargate stops immediately, Aurora auto-pauses after 5 min idle
# Running cost when stopped: ~$2/mo (ElastiCache Serverless minimum + Secrets Manager)
aws ecs update-service --cluster omega-stream --service omega-stream --desired-count 0

# Start — task launches in ~60s, Aurora resumes in ~15s on first query
aws ecs update-service --cluster omega-stream --service omega-stream --desired-count 1
```

### What costs what when stopped

| Resource | Running | Stopped |
|---|---|---|
| Fargate task | ~$0.05/hr | $0 |
| Aurora (auto-pauses after 5 min) | ~$0.06/hr per ACU | $0 |
| ElastiCache Serverless | pay-per-use + 100MB min | ~$1.70/mo (100MB minimum storage) |
| Secrets Manager | $0.40/secret/mo | $0.40/secret/mo |
| SQS, ECR, CloudWatch | Free tier | Free tier |
| **Total** | **~$0.11/hr (~$50/mo if 24/7)** | **~$2.50/mo** |

### Cost examples

| Usage pattern | Est. Monthly Cost |
|---|---|
| Always on (24/7) | ~$50/mo |
| Weekday business hours only (8h × 22 days) | ~$22/mo |
| A few hours per week (3h × 4 weeks) | ~$5/mo |
| Stopped all month | ~$2.50/mo |

With $200 in AWS credits: **4 months+ at heavy use, effectively unlimited at light use.**

---

## Estimated Monthly Cost (Always-On Reference)

| Component | Est. Cost |
|---|---|
| Fargate (1 task, 1 vCPU / 2 GB, 24/7) | ~$36 |
| Aurora Serverless v2 (mostly paused) | ~$5–10 |
| ElastiCache Serverless (minimal use) | ~$5–15 |
| Secrets Manager (2 secrets) | $0.80 |
| SQS, ECR, CloudWatch | Free tier |
| **Total** | **~$50/mo** |

---

## What Changes to Exit Test Mode (Future)

When ready for production, the following changes are needed:

| Change | What to add |
|---|---|
| Split into separate services | 4 ECS services with independent task definitions |
| ALB | Path-based routing (`/api/*` → API, default → Web), single entry point on port 80/443 |
| NLB for RTMP | Stable endpoint, TCP health checks, 300s deregistration delay |
| CloudFront | Cache static assets, SSR optimization, SSL termination |
| NAT Gateway | Move tasks to private subnets |
| Auto-scaling | Per-service scaling policies (CPU, SQS depth) |
| Monitoring | CloudWatch alarms, SNS topic, dashboards |
| Database | Replace RDS Postgres t4g.micro with Aurora Serverless v2 (Multi-AZ, min ACU 0.5, backup retention 7+ days) |
| Per-service SGs | Separate security groups for least-privilege isolation |
| Per-service IAM | Individual task roles with minimal permissions |
| SSE/WS strategy | Server 30s heartbeat, ALB 300s idle timeout, CF response timeout tuning |

---

## Resolved Decisions

| # | Topic | Decision | Rationale |
|---|---|---|---|
| 1 | Deployment mode | Test mode — single consolidated Fargate task | Minimize cost (~$50/mo vs ~$200/mo), simplify infra, validate end-to-end |
| 2 | ALB | Skip for test mode | Access task directly by IP:port — saves $16/mo fixed cost, allows full pause to ~$2/mo |
| 3 | NLB | Skip for test mode | Use task public IP for RTMP (IP changes on redeploy — acceptable) |
| 4 | NAT Gateway | None | Task in public subnet with `assignPublicIp` — no NAT needed |
| 5 | CloudFront | Skip for test mode | No caching or edge optimization needed for testing |
| 6 | ECR repos | CDK-managed, `removalPolicy: RETAIN` | Survives `cdk destroy` |
| 7 | Stack count | 3 stacks (Network, Data, Service) | Minimal complexity for test mode |
| 8 | IAM roles | Shared execution role, single task role | Combined permissions — split per-service for prod |
| 9 | Database | RDS Postgres `db.t4g.micro` instead of Aurora Serverless v2 | Free-tier account requires Aurora express config (no VPC, IAM auth only); RDS instance is drop-in compatible with Prisma password auth. Swap to Aurora Serverless v2 when account is upgraded. |
| 10 | Cache | ElastiCache Serverless (Valkey) | Pay-per-use, built-in HA, TLS+auth by default |
| 11 | Secrets injection | ECS native `secrets` field | Simplest approach, no app-level SDK code |
| 12 | Ingest discovery | Redis registry (IP + heartbeat) | Same code path locally and in AWS |
| 13 | Logging | `/omega-stream/test/{service}`, 14-day retention | No alarms or dashboards in test mode |
| 14 | SQS visibility timeout | 30s | Worker processing is fast; lower timeout reduces head-of-line blocking |
| 15 | SSL/TLS | HTTP-only | No ACM cert needed for testing |
| 16 | Auto-scaling | None | Single task, `desiredCount: 1` |
| 17 | Monitoring | CloudWatch Logs only | No alarms, SNS, or dashboards in test mode |
| 18 | CI/CD | Manual deploys (`cdk deploy -c imageTag=...`) | GitHub Actions later |
| 19 | Task size | 1 vCPU / 2 GB RAM | Shared across 4 containers — sufficient for light testing |
| 20 | Cost control | Start/stop via `desired-count 0/1` | ~$2.50/mo when stopped, ~$0.11/hr when running |
| 21 | Container resource split | API 128/384, Web 192/512, Ingest 128/256, Worker 576/896 (CPU units/MB) | Worker gets 56% CPU for FFmpeg |
| 22 | Redis client (AWS) | ElastiCache Serverless + IAM auth; factory switches on env for local plain Redis | No local emulator; two code paths in one factory function |
| 23 | API Dockerfile | Multi-stage Node.js build with `prisma generate` | Same pattern as existing web Dockerfile |
| 24 | Worker Dockerfile | `node:22-slim` + static FFmpeg binary | Debian-based for reliable codec support |
| 25 | DB schema on deploy | API entrypoint runs `prisma db push` (swap to `migrate deploy` later) | Idempotent; ~2-3s overhead, negligible vs Aurora 15s resume |
| 26 | Web → API routing | Next.js `rewrites()` proxies `/api/*` to `localhost:3000` | Eliminates CORS and dynamic IP issues for browser requests |
| 27 | Container startup order | API first; Ingest, Web, Worker depend on API HEALTHY | Ingest callbacks and web proxy need API ready |
| 28 | Internal secret | Third Secrets Manager entry, injected into API + Ingest | $0.40/mo; auth credential shouldn't be plain env var |
| 29 | Aurora credentials | Inject individual fields (`DB_HOST`, etc.) via `secretStringKey`; assemble `DATABASE_URL` in entrypoint | Works with auto-rotation; keeps connection string format under app control |
| 30 | Image tagging | Git short SHA | Traceable to exact commit; helper script automates build+push |
| 31 | CDK context | Only `imageTag` required; account/region from AWS env | No multi-environment config until needed |
| 32 | VPC subnets | 2 AZs, `/24` subnets, `PRIVATE_ISOLATED` (no NAT) | CDK defaults; 254 IPs per subnet is plenty |
| 33 | Deploy strategy | Stop-then-start (`minHealthy: 0, maxPercent: 100`) | Brief downtime acceptable; avoids 2-task overlap |
| 34 | Log groups | 5 total: 4 ECS `awsLogs` + 1 FFmpeg `PutLogEvents` | CDK manages all for consistent retention + IAM |
| 35 | Resource naming | `omega-stream` prefix, stacks `OmegaStream{Network,Data,Service}` | Consistent, identifiable in AWS console |
| 36 | CORS | Not needed in test mode | Next.js proxy makes all API calls same-origin |
| 37 | Public ports | Only 3002 (Web) and 1935 (RTMP) in SG inbound | API on 3000 is internal-only via localhost; reduces attack surface |
