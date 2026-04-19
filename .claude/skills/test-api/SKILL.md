---
name: test-api
description: Run the API service test suite. Use when user wants to run API tests.
allowed-tools: Bash
---

Run the `apps/api` integration tests. These tests hit real Postgres and Redis instances, so infrastructure must be running first.

## Steps

### 1. Check dependencies

If `node_modules` does not exist at the repo root, run `pnpm install`.

### 2. Start Docker infrastructure

The tests require Postgres and Redis. First, check if they are already running:

```
docker compose ps --status running --format '{{.Name}}' 2>/dev/null
```

Note which services were **already running** before you start anything — you will need this in the cleanup step. If both `sruth-postgres` and `omega-api-redis` are already listed, skip starting them.

If either is not running, start them:

```
POSTGRES_USER=sruth POSTGRES_PASSWORD=sruth POSTGRES_DB=sruth docker compose up -d --wait postgres redis
```

The `--wait` flag blocks until the healthchecks pass. Do NOT proceed until this completes successfully.

### 3. Create the test database

The vitest config (`apps/api/vitest.config.ts`) hardcodes `DATABASE_URL` to use the database `sruth_test` — this is a **separate database** from the dev `sruth` database. Postgres will only have the `sruth` database by default, so you must create the test database if it doesn't exist:

```
docker exec sruth-postgres psql -U sruth -d sruth -c "CREATE DATABASE sruth_test;" 2>&1
```

If it already exists, the command will error with "already exists" — that's fine, ignore it and continue.

### 4. Push the Prisma schema to the test database

The schema must be pushed to `sruth_test` specifically. Always use `DATABASE_URL` pointing at the test database:

```
DATABASE_URL="postgresql://sruth:sruth@localhost:5432/sruth_test" pnpm --filter @sruth/api db:push
```

**Important**: If this fails with enum conflicts or data loss warnings, the test database has stale schema. Reset it:

```
docker exec sruth-postgres psql -U sruth -d sruth_test -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
```

Then re-run the `db:push` command above. Do NOT use `--accept-data-loss` — dropping and recreating the schema is cleaner for a test database.

### 5. Generate the Prisma client

If tests fail with `Cannot find module '.prisma/client/default'`, run:

```
pnpm --filter @sruth/api db:generate
```

### 6. Run the tests

```
pnpm --filter @sruth/api test
```

The vitest config already sets all required env vars (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, etc.), so you do NOT need to pass them — just run the command as-is.

Report the test results summary (pass/fail counts, failed test names if any) to the user.

### 7. Clean up Docker infrastructure

If you started Docker services in step 2 (they were NOT already running before), shut them down:

```
docker compose down
```

If the services were already running before you started, leave them running — the user likely has them up for development.
