# Worker Docker image — design notes

This document captures the design decisions behind `services/worker/Dockerfile`
and the broader dockerization plan for omega-stream services. It was produced
from a grill-me session before the first version of the Dockerfile was written,
so it also serves as a scope anchor for follow-up work (API image, ECS wiring).

## Goals

- Produce a minimal, reproducible image for the worker that ECS Fargate can pull
  from ECR and run without privileged access.
- Include the ffmpeg binary the worker spawns for RTMP restreaming.
- Forward SIGTERM correctly so in-flight streams are shut down cleanly and
  child ffmpeg processes are reaped.
- Match the conventions of the existing `apps/web/Dockerfile` where possible.

## Image structure

Three-stage Alpine build (`node:22-alpine`):

1. **deps** — installs pnpm via `corepack`, copies root workspace manifests and
   the worker + shared `package.json` files, runs
   `pnpm install --frozen-lockfile --filter @omega-stream/worker...`. Source
   code is **not** copied here so the install layer is cached aggressively.
2. **builder** — copies source for `packages/shared` and `services/worker`,
   builds shared first (it's a TS library consumed as compiled JS), then
   compiles the worker with `tsc`, then runs
   `pnpm --filter @omega-stream/worker deploy --prod --legacy /deploy/worker`
   to produce a self-contained flat tree.
3. **runner** — minimal `node:22-alpine` with `ffmpeg` and `tini` added,
   creates a non-root `worker:1001` user, copies the `/deploy/worker` tree
   verbatim. Runs `node dist/index.js` under `tini` as PID 1.

## Resolved design decisions

### Build context is the repo root
All `docker build` invocations use `.` (repo root) as the context. This is
required because the worker depends on `@omega-stream/shared`, which lives
outside `services/worker/`. The `.dockerignore` lives at the repo root
(not in `services/worker/`) because Docker resolves `.dockerignore` relative
to the build context root, not the Dockerfile directory.

### `pnpm deploy --legacy` for a flat production tree
pnpm workspaces normally install dependencies as a mix of hoisted packages in
`/app/node_modules/.pnpm/` plus symlinks under each workspace package. Copying
only `services/worker/node_modules` to the runner would produce dangling
symlinks. `pnpm deploy` resolves this by materializing a flat, self-contained
dependency tree at a target directory, inlining workspace deps (like `shared`)
as regular folders.

The `--legacy` flag is required because pnpm v10 changed `pnpm deploy` to only
support workspaces that opt into the injected-dependencies model via
`inject-workspace-packages=true`. This repo uses the traditional symlink model,
so `--legacy` tells pnpm to use the pre-v10 deploy implementation. The
alternative (setting `inject-workspace-packages=true` globally) would change
the installation model for every workspace package — a much broader change
than justified.

### Alpine ffmpeg is sufficient
The worker spawns ffmpeg with `-c copy -f flv` — pure stream copy, no
transcoding, FLV muxer over RTMP. Alpine's stock `ffmpeg` package supports
this fully. `--disable-librtmp` in the build config only disables the external
librtmp library; ffmpeg's native RTMP implementation is present
(confirmed via `ffmpeg -protocols`: `rtmp`, `rtmps`, `rtmpt*` all listed).

### `tini` as PID 1
The worker spawns ffmpeg child processes and has explicit SIGTERM shutdown
handling in [src/index.ts](src/index.ts) and [src/ffmpeg-manager.ts](src/ffmpeg-manager.ts).
The code itself handles the normal shutdown path correctly. `tini` is added as
defence-in-depth: it forwards SIGTERM cleanly to Node regardless of shell
wrapping, and reaps any orphaned ffmpeg grandchildren that might slip past
Node's own child-process reaping. Cost is ~1MB, benefit is robustness against
edge cases.

### Non-root user
Runner stage creates `nodejs:1001` group and `worker:1001` user, copies the
deploy tree with `--chown=worker:nodejs`, and switches with `USER worker`.
Matches the pattern in `apps/web/Dockerfile`. ffmpeg writes to stdout pipes
rather than the filesystem, so no additional permission setup is needed.

### No worker code changes were required
- The worker already reads env vars via `process.env.*` directly — no dotenv
  wrapper at runtime.
- SIGTERM handling is already in place (src/index.ts lines 137–138).
- Logging goes to stdout/stderr as expected for container environments.

### Base image pinning
Using `node:22-alpine` (minor-floating) to match `apps/web/Dockerfile`.
Consistency across services matters more than exact reproducibility for now.
Tighter pinning (e.g. `node:22.11.0-alpine3.20@sha256:...`) can be done for
all three services in one pass later.

## Deferred work

The grill-me session surfaced several gaps that are out of scope for the
initial worker Dockerfile but need to be resolved before the full stack can
run in ECS:

| Issue | Summary |
|-------|---------|
| #47 | Remove curl from future API image by swapping ECS health check to a node-based probe |
| #48 | API image will run `prisma generate` twice — investigate single-generate alternatives (custom output path is most promising) |
| #49 | **Blocker for deploy:** Worker container in service-stack.ts has no env vars — `SQS_QUEUE_URL`, `REDIS_URL`, `AWS_REGION` all missing |
| #50 | **Blocker for deploy:** ElastiCache Serverless uses IAM auth but both worker and API connect to Redis with a plain `new Redis(url)` — needs SigV4 token generation |
| #51 | **Blocker for API Dockerfile:** Pre-existing TypeScript errors in the API codebase fail `tsc`. Latent because dev uses `tsx watch` which skips type checking |

The worker image can be built and pushed to ECR immediately, but will not
successfully run in ECS until #49 and #50 are resolved. The API image cannot
be added until #51 is resolved.

## Verification

```
# From repo root:
docker build -f services/worker/Dockerfile -t omega-stream-worker .

# Verify ffmpeg and RTMP protocols:
docker run --rm omega-stream-worker ffmpeg -version
docker run --rm omega-stream-worker ffmpeg -protocols | grep rtmp

# Smoke-test Node under tini:
docker run --rm --entrypoint /sbin/tini omega-stream-worker -- \
  node -e "console.log('ok')"
```

All four checks pass on the initial version of the image.
