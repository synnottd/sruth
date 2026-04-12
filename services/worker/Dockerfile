# syntax=docker/dockerfile:1.7
#
# Worker image — SQS consumer that spawns FFmpeg for RTMP restreaming.
# Build context: repo root. Example:
#   docker build -f services/worker/Dockerfile -t omega-stream-worker .

# ---- Stage 1: deps ----
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY services/worker/package.json services/worker/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --filter @omega-stream/worker...

# ---- Stage 2: builder ----
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/worker/node_modules ./services/worker/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY services/worker services/worker

# Build shared first (worker imports its built output), then the worker.
RUN pnpm --filter @omega-stream/shared build
RUN pnpm --filter @omega-stream/worker exec tsc

# Produce a self-contained production tree at /deploy/worker.
RUN pnpm --filter @omega-stream/worker deploy --prod --legacy /deploy/worker

# ---- Stage 3: runner ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# ffmpeg: spawned as a child process for RTMP restreaming (-c copy, FLV mux).
# tini: PID 1 for correct SIGTERM forwarding and zombie reaping of FFmpeg children.
RUN apk add --no-cache ffmpeg tini

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 worker

COPY --from=builder --chown=worker:nodejs /deploy/worker ./

USER worker

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
