import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { getApp, getInternalApp, closeApp, registerUser } from './helper.js';

vi.mock('../src/lib/commands.js', () => ({
  sendCommand: vi.fn(),
}));

afterAll(() => closeApp());

const INTERNAL_HEADERS = { 'x-internal-secret': process.env.INTERNAL_SECRET ?? 'test-secret' };

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

beforeEach(async () => {
  const { sendCommand } = await import('../src/lib/commands.js');
  (sendCommand as unknown as ReturnType<typeof vi.fn>).mockClear();
});

/** Set up a user with an output, and optionally an active stream + output-session status. */
async function setupUserWithOutput(
  email: string,
  opts: { active?: boolean; outputSessionStatus?: 'STARTING' | 'LIVE' | 'RETRYING' | 'ERROR' | 'STOPPED' } = {},
) {
  const { body } = await registerUser({ email });
  const app = await getApp();
  const headers = { authorization: `Bearer ${body.accessToken}` };

  const outputRes = await app.inject({
    method: 'POST',
    url: '/outputs',
    headers,
    payload: {
      name: 'Test Output',
      platform: 'TWITCH',
      rtmpUrl: 'rtmp://live.twitch.tv/app',
      streamKey: 'live_test',
    },
  });
  const output = JSON.parse(outputRes.body);

  if (opts.active) {
    const internal = await getInternalApp();
    await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${body.streamKey}&addr=10.0.0.1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });
    if (opts.outputSessionStatus && opts.outputSessionStatus !== 'STARTING') {
      await prisma.outputSession.updateMany({
        where: { output: { id: output.id } },
        data: { status: opts.outputSessionStatus },
      });
    }
  }

  return { headers, outputId: output.id };
}

describe('PUT /outputs/:id enabled toggle — live side effects', () => {
  it('enqueues a stop command when disabling a LIVE output mid-session', async () => {
    const { headers, outputId } = await setupUserWithOutput('toggle-off-live@example.com', {
      active: true,
      outputSessionStatus: 'LIVE',
    });
    const app = await getApp();

    const os = await prisma.outputSession.findFirst({ where: { outputId } });

    const res = await app.inject({
      method: 'PUT',
      url: `/outputs/${outputId}`,
      headers,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);

    const { sendCommand } = await import('../src/lib/commands.js');
    const mock = sendCommand as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'stop',
        outputSessionId: os!.id,
      }),
    );
  });

  it('creates an OutputSession and enqueues start when enabling with no prior row', async () => {
    // Create a disabled output, then simulate on-publish (which skips disabled outputs),
    // then enable it — should create the OutputSession and enqueue start.
    const { body } = await registerUser({ email: 'toggle-on-new@example.com' });
    const app = await getApp();
    const internal = await getInternalApp();
    const headers = { authorization: `Bearer ${body.accessToken}` };

    const outputRes = await app.inject({
      method: 'POST',
      url: '/outputs',
      headers,
      payload: {
        name: 'Disabled Output',
        platform: 'TWITCH',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        streamKey: 'live_test',
      },
    });
    const output = JSON.parse(outputRes.body);

    // Disable it first
    await prisma.output.update({ where: { id: output.id }, data: { enabled: false } });

    // Simulate active stream — on-publish filters enabled:true, so no OutputSession is created
    await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${body.streamKey}&addr=10.0.0.1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    const before = await prisma.outputSession.findFirst({ where: { outputId: output.id } });
    expect(before).toBeNull();

    const { sendCommand } = await import('../src/lib/commands.js');
    const mock = sendCommand as unknown as ReturnType<typeof vi.fn>;
    mock.mockClear();

    // Toggle ON
    const res = await app.inject({
      method: 'PUT',
      url: `/outputs/${output.id}`,
      headers,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.outputSession.findFirst({ where: { outputId: output.id } });
    expect(after).not.toBeNull();
    expect(after!.status).toBe('STARTING');

    expect(mock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'start',
        outputSessionId: after!.id,
      }),
    );
  });

  it('resets an ERROR OutputSession when re-enabling', async () => {
    const { headers, outputId } = await setupUserWithOutput('toggle-on-err@example.com', {
      active: true,
      outputSessionStatus: 'ERROR',
    });
    const app = await getApp();

    const before = await prisma.outputSession.findFirst({ where: { outputId } });
    // Seed error details and reconnectCount to verify they get cleared
    await prisma.outputSession.update({
      where: { id: before!.id },
      data: { lastError: 'boom', reconnectCount: 7 },
    });

    // App won't know it's "disabled" because we went straight to ERROR without flipping,
    // so first flip the output to disabled to establish the "enabled changed" transition.
    await prisma.output.update({ where: { id: outputId }, data: { enabled: false } });

    const { sendCommand } = await import('../src/lib/commands.js');
    const mock = sendCommand as unknown as ReturnType<typeof vi.fn>;
    mock.mockClear();

    const res = await app.inject({
      method: 'PUT',
      url: `/outputs/${outputId}`,
      headers,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.outputSession.findUnique({ where: { id: before!.id } });
    expect(after!.status).toBe('STARTING');
    expect(after!.lastError).toBeNull();
    expect(after!.reconnectCount).toBe(0);
    expect(after!.endedAt).toBeNull();

    expect(mock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'start',
        outputSessionId: before!.id,
      }),
    );
  });

  it('does not enqueue a command when an already-LIVE output is toggled on', async () => {
    const { headers, outputId } = await setupUserWithOutput('toggle-on-live@example.com', {
      active: true,
      outputSessionStatus: 'LIVE',
    });
    // Force a "no change" scenario at the DB level (output.enabled is already true).
    // Then we send enabled:true explicitly — state machine should see "unchanged".
    const app = await getApp();

    const { sendCommand } = await import('../src/lib/commands.js');
    const mock = sendCommand as unknown as ReturnType<typeof vi.fn>;
    mock.mockClear();

    const res = await app.inject({
      method: 'PUT',
      url: `/outputs/${outputId}`,
      headers,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(mock).not.toHaveBeenCalled();

    // But even if enabled DID change (disable then enable), an already-LIVE row stays LIVE with no command.
    // We verify by simulating the "rapid flip" path.
    await prisma.output.update({ where: { id: outputId }, data: { enabled: false } });
    mock.mockClear();
    const res2 = await app.inject({
      method: 'PUT',
      url: `/outputs/${outputId}`,
      headers,
      payload: { enabled: true },
    });
    expect(res2.statusCode).toBe(200);
    // OutputSession is still LIVE — no-op on the session side, no command.
    expect(mock).not.toHaveBeenCalled();
  });

  it('does not enqueue a command when only non-enabled fields change', async () => {
    const { headers, outputId } = await setupUserWithOutput('toggle-name-change@example.com', {
      active: true,
      outputSessionStatus: 'LIVE',
    });
    const app = await getApp();

    const { sendCommand } = await import('../src/lib/commands.js');
    const mock = sendCommand as unknown as ReturnType<typeof vi.fn>;
    mock.mockClear();

    const res = await app.inject({
      method: 'PUT',
      url: `/outputs/${outputId}`,
      headers,
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(mock).not.toHaveBeenCalled();
  });

  it('does not enqueue a command when offline (no active session), regardless of direction', async () => {
    const { headers, outputId } = await setupUserWithOutput('toggle-offline@example.com');
    const app = await getApp();

    const { sendCommand } = await import('../src/lib/commands.js');
    const mock = sendCommand as unknown as ReturnType<typeof vi.fn>;
    mock.mockClear();

    // Toggle off offline — no command
    const offRes = await app.inject({
      method: 'PUT',
      url: `/outputs/${outputId}`,
      headers,
      payload: { enabled: false },
    });
    expect(offRes.statusCode).toBe(200);
    expect(mock).not.toHaveBeenCalled();

    // Toggle on offline — no command
    mock.mockClear();
    const onRes = await app.inject({
      method: 'PUT',
      url: `/outputs/${outputId}`,
      headers,
      payload: { enabled: true },
    });
    expect(onRes.statusCode).toBe(200);
    expect(mock).not.toHaveBeenCalled();
  });
});
