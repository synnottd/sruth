# Stage 1: Install dependencies
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @sruth/api...

# Stage 2: Build
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY apps/api apps/api
COPY packages/shared packages/shared
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# Generate Prisma client
#
# The shared schema declares a `generator erd` block for docs. Its binary
# (`prisma-erd-generator`) is a devDep of `packages/shared` only, so a
# service-filtered `pnpm install` doesn't install it and `prisma generate`
# fails with "not found". Strip the block before generating — the committed
# docs/erd.md is the source of truth and is regenerated via a local workflow.
RUN sed -i '/^generator erd {/,/^}$/d' packages/shared/prisma/schema.prisma && \
    cd apps/api && npx prisma generate --config prisma/prisma.config.ts

# Build shared package
RUN pnpm --filter @sruth/shared build

# Build API
RUN pnpm --filter @sruth/api build

# Stage 3: Production runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nodejs

# Copy built output and dependencies
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder --chown=nodejs:nodejs /app/packages/shared ./packages/shared
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json

USER nodejs

EXPOSE 3000 3001

CMD ["node", "apps/api/dist/index.js"]
