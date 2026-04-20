import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchPublishers } from '../src/lib/mediamtx.js';

/**
 * fetchPublishers() wraps MediaMTX's `/v3/paths/list` endpoint so the admin
 * status composer can display live publishers. The wrapper is the *only*
 * place that knows about auth, path-prefix stripping, uptime computation,
 * and (crucially) the degraded response — every failure mode (refused,
 * timeout, 401, 5xx, malformed JSON) must collapse to
 * { reachable: false, publishers: [] } so the caller never has to branch.
 */

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_MEDIAMTX_URL = process.env.MEDIAMTX_API_URL;
const ORIGINAL_INTERNAL_SECRET = process.env.INTERNAL_SECRET;

describe('fetchPublishers', () => {
  beforeEach(() => {
    process.env.MEDIAMTX_API_URL = 'http://ingest:9997';
    process.env.INTERNAL_SECRET = 'test-secret';
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_MEDIAMTX_URL === undefined) delete process.env.MEDIAMTX_API_URL;
    else process.env.MEDIAMTX_API_URL = ORIGINAL_MEDIAMTX_URL;
    if (ORIGINAL_INTERNAL_SECRET === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = ORIGINAL_INTERNAL_SECRET;
    vi.restoreAllMocks();
  });

  it('returns reachable=true with mapped publishers for a valid response', async () => {
    // Fixture shape verified against MediaMTX v1.17.1 live probe.
    const readyTime = new Date(Date.now() - 90_000).toISOString();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          items: [
            {
              name: 'live/abc123',
              ready: true,
              readyTime,
              source: { type: 'rtmpConn', id: 'c1' },
            },
          ],
        };
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchPublishers();

    expect(result.reachable).toBe(true);
    expect(result.publishers).toHaveLength(1);
    expect(result.publishers[0].streamKey).toBe('abc123');
    expect(result.publishers[0].protocol).toBe('rtmp');
    expect(result.publishers[0].uptimeSec).toBeGreaterThanOrEqual(89);
    expect(result.publishers[0].uptimeSec).toBeLessThanOrEqual(91);
  });

  it('sends Basic auth with sruth-api:INTERNAL_SECRET and hits /v3/paths/list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return { items: [] };
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchPublishers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ingest:9997/v3/paths/list');
    const expectedAuth = 'Basic ' + Buffer.from('sruth-api:test-secret').toString('base64');
    // `init.headers` can be a Headers instance or plain object depending on runtime.
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(expectedAuth);
  });

  it('filters out items where ready is false', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          items: [
            {
              name: 'live/live-one',
              ready: true,
              readyTime: new Date().toISOString(),
              source: { type: 'rtmpConn', id: 'c1' },
            },
            {
              name: 'live/idle-one',
              ready: false,
              readyTime: null,
              source: null,
            },
          ],
        };
      },
    }) as unknown as typeof fetch;

    const result = await fetchPublishers();
    expect(result.publishers).toHaveLength(1);
    expect(result.publishers[0].streamKey).toBe('live-one');
  });

  it('drops items whose source.type is unknown (defensive against convention drift)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          items: [
            {
              name: 'live/good',
              ready: true,
              readyTime: new Date().toISOString(),
              source: { type: 'rtmpConn', id: 'c1' },
            },
            {
              name: 'live/weird',
              ready: true,
              readyTime: new Date().toISOString(),
              source: { type: 'someNewProtocolConn', id: 'c2' },
            },
          ],
        };
      },
    }) as unknown as typeof fetch;

    const result = await fetchPublishers();
    expect(result.publishers).toHaveLength(1);
    expect(result.publishers[0].streamKey).toBe('good');
  });

  it('maps srtConn to protocol=srt', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          items: [
            {
              name: 'live/srt-key',
              ready: true,
              readyTime: new Date().toISOString(),
              source: { type: 'srtConn', id: 'c1' },
            },
          ],
        };
      },
    }) as unknown as typeof fetch;

    const result = await fetchPublishers();
    expect(result.publishers[0].protocol).toBe('srt');
  });

  it('returns reachable=false when MediaMTX responds 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      async json() {
        return {};
      },
    }) as unknown as typeof fetch;

    const result = await fetchPublishers();
    expect(result).toEqual({ reachable: false, publishers: [] });
  });

  it('returns reachable=false when the connection is refused', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const result = await fetchPublishers();
    expect(result).toEqual({ reachable: false, publishers: [] });
  });

  it('returns reachable=false when the response body is malformed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        throw new Error('Unexpected token < in JSON');
      },
    }) as unknown as typeof fetch;

    const result = await fetchPublishers();
    expect(result).toEqual({ reachable: false, publishers: [] });
  });

  it('returns reachable=false when the request times out via AbortController', async () => {
    // Simulate fetch throwing an AbortError (what fetch does when the signal
    // fires). We don't need to wait the real timeout for the unit test.
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const result = await fetchPublishers();
    expect(result).toEqual({ reachable: false, publishers: [] });
  });
});
