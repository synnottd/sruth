---
name: test-api
description: Run the API service test suite. Use when user wants to run API tests.
allowed-tools: Bash
---

Run the API test suite with:

```
pnpm --filter @omega-stream/api test
```

Before running tests, ensure dependencies are ready:

1. Check that `node_modules` exists. If not, run `pnpm install`.
2. If tests fail with `Cannot find module '.prisma/client/default'`, run `pnpm --filter @omega-stream/api exec prisma generate` and retry.

Report the test results summary (pass/fail counts) to the user.
