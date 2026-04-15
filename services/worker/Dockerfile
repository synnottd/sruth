# Stage 1: Install dependencies
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY services/worker/package.json services/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @sruth/worker...

# Stage 2: Build
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/worker/node_modules ./services/worker/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY services/worker services/worker
COPY packages/shared packages/shared
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Generate Prisma client
RUN cd services/worker && npx prisma generate --config prisma/prisma.config.ts

# Build shared package
RUN pnpm --filter @sruth/shared build

# Build worker
RUN pnpm --filter @sruth/worker build

# Stage 3: Production runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install FFmpeg
RUN apk add --no-cache ffmpeg

# Copy built output and dependencies
COPY --from=builder /app/services/worker/dist ./services/worker/dist
COPY --from=builder /app/services/worker/package.json ./services/worker/package.json
COPY --from=builder /app/services/worker/node_modules ./services/worker/node_modules
COPY --from=builder /app/services/worker/prisma ./services/worker/prisma
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 4000

CMD ["node", "services/worker/dist/index.js"]
