import { hostname } from 'node:os';

export function resolveWorkerId(): string {
  const id = hostname();
  console.log('[Identity] Worker ID:', id);
  return id;
}
