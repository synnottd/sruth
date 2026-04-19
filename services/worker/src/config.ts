export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://sruth:sruth@localhost:5432/sruth',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1000),
  httpPort: Number(process.env.HTTP_PORT ?? 4000),
  ingestPort: Number(process.env.INGEST_PORT ?? 1935),
  ingestApp: process.env.INGEST_APP ?? 'live',
  ingestIpOverride: process.env.INGEST_IP_OVERRIDE,
  internalSecret: process.env.INTERNAL_SECRET,
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
