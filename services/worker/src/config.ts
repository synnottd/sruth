export const config = {
  sqsQueueUrl: process.env.SQS_QUEUE_URL ?? 'http://localhost:9324/000000000000/omega-stream-worker.fifo',
  sqsEndpoint: process.env.SQS_ENDPOINT, // e.g. http://localhost:9324 for ElasticMQ
  sqsWaitTimeSeconds: 20,
  sqsMaxMessages: 10,
  sqsVisibilityTimeout: 60,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  localDev: process.env.LOCAL_DEV === 'true' || !process.env.ECS_CONTAINER_METADATA_URI_V4,
} as const;
