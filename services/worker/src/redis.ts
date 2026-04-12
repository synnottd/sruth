import { Redis } from 'ioredis';
import { config } from './config.js';

let redis: Redis | null = null;
let subscriber: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  }
  return redis;
}

/** Separate connection for pub/sub (ioredis requires dedicated connection in subscriber mode). */
export function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  }
  return subscriber;
}

export async function shutdownRedis(): Promise<void> {
  const promises: Promise<void>[] = [];
  const sub = subscriber;
  const cmd = redis;
  // Null references first to prevent new connections during shutdown
  subscriber = null;
  redis = null;
  if (sub) {
    promises.push(sub.quit().then(() => {}));
  }
  if (cmd) {
    promises.push(cmd.quit().then(() => {}));
  }
  await Promise.all(promises);
}
