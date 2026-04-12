import { randomUUID } from 'node:crypto';
import { config } from './config.js';

/**
 * Resolve worker ID from ECS container metadata or generate a UUID for local dev.
 */
export async function resolveWorkerId(): Promise<string> {
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (metadataUri) {
    try {
      const resp = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) {
        throw new Error(`ECS metadata returned ${resp.status}`);
      }
      const data = await resp.json() as { TaskARN?: string };
      if (data.TaskARN) {
        // Use last segment of ARN as a stable, short ID
        const parts = data.TaskARN.split('/');
        const taskId = parts[parts.length - 1];
        console.log('[Identity] Worker ID from ECS:', taskId);
        return taskId;
      }
    } catch (err) {
      console.warn('[Identity] Failed to read ECS metadata, falling back to UUID:', err);
    }
  }

  const id = randomUUID();
  console.log('[Identity] Worker ID (local dev):', id);
  return id;
}
