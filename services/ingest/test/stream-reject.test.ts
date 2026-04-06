import { describe, it, expect, beforeEach } from 'vitest'
import { pushStream } from './helpers/rtmp.js'
import { resetMockApi, getMockApiState } from './helpers/mock-api.js'

describe('stream rejection', () => {
  beforeEach(() => resetMockApi(401))

  it('disconnects the publisher when on_publish returns 401', async () => {
    // Use a long duration — if rejection works, ffmpeg will exit early
    const result = await pushStream('invalid-key', 30)

    expect(result.exitCode).not.toBe(0)
  })

  it('still fires the on_publish callback before rejecting', async () => {
    await pushStream('invalid-key', 30)

    const state = await getMockApiState()
    const call = state.calls.find((c) => c.path === '/internal/stream/on-publish')

    expect(call).toBeDefined()
    expect(call!.body.name).toBe('invalid-key')
  })

  it('does not fire on_publish_done when stream was rejected', async () => {
    await pushStream('invalid-key', 30)

    const state = await getMockApiState()
    const doneCall = state.calls.find((c) => c.path === '/internal/stream/on-publish-done')

    expect(doneCall).toBeUndefined()
  })
})
