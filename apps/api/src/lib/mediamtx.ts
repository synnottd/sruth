export interface Publisher {
  streamKey: string;
  protocol: 'rtmp' | 'srt';
  uptimeSec: number;
}

export interface FetchPublishersResult {
  reachable: boolean;
  publishers: Publisher[];
}

interface MediaMtxPathItem {
  name: string;
  ready: boolean;
  readyTime: string | null;
  source: { type: string; id?: string } | null;
}

interface MediaMtxPathsList {
  items: MediaMtxPathItem[];
}

const DEFAULT_TIMEOUT_MS = 2_000;

const DEGRADED: FetchPublishersResult = { reachable: false, publishers: [] };

function authHeader(): string {
  const secret = process.env.INTERNAL_SECRET ?? '';
  return 'Basic ' + Buffer.from(`sruth-api:${secret}`).toString('base64');
}

function mapProtocol(sourceType: string | undefined): 'rtmp' | 'srt' | null {
  if (sourceType === 'rtmpConn') return 'rtmp';
  if (sourceType === 'srtConn') return 'srt';
  return null;
}

/**
 * Query MediaMTX's paths/list endpoint and project it into the admin-dashboard
 * shape. All error paths collapse to { reachable: false, publishers: [] } so
 * callers don't have to distinguish between "ingest is down", "auth is wrong",
 * and "MediaMTX returned garbage" — from the operator's point of view they all
 * mean "no live data" and the UI shows the same banner either way.
 */
export async function fetchPublishers(
  options: { timeoutMs?: number } = {},
): Promise<FetchPublishersResult> {
  const base = process.env.MEDIAMTX_API_URL ?? 'http://localhost:9997';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/v3/paths/list`, {
      headers: { authorization: authHeader() },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('[mediamtx] non-ok response', res.status);
      return DEGRADED;
    }
    const body = (await res.json()) as MediaMtxPathsList;
    const items = Array.isArray(body?.items) ? body.items : [];

    const now = Date.now();
    const publishers: Publisher[] = [];
    for (const item of items) {
      if (!item?.ready) continue;
      const protocol = mapProtocol(item.source?.type);
      if (protocol === null) continue;
      if (!item.readyTime) continue;
      const started = new Date(item.readyTime).getTime();
      if (Number.isNaN(started)) continue;
      publishers.push({
        streamKey: item.name.replace(/^live\//, ''),
        protocol,
        uptimeSec: Math.floor((now - started) / 1000),
      });
    }

    return { reachable: true, publishers };
  } catch (err) {
    console.warn('[mediamtx] fetchPublishers failed:', (err as Error).message);
    return DEGRADED;
  } finally {
    clearTimeout(timeout);
  }
}
