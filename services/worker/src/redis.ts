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
  if (subscriber) {
    promises.push(subscriber.quit().then(() => {}));
    subscriber = null;
  }
  if (redis) {
    promises.push(redis.quit().then(() => {}));
    redis = null;
  }
  await Promise.all(promises);
}
