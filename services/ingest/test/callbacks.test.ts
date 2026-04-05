import { describe, it, expect, beforeEach } from 'vitest'
import { pushStream } from './helpers/rtmp.js'
import { resetMockApi, getMockApiState, waitForCallback } from './helpers/mock-api.js'

describe('nginx-rtmp lifecycle callbacks', () => {
  beforeEach(() => resetMockApi(200))

  it('fires on_publish_done when the stream ends', async () => {
    await pushStream('lifecycle-key', 2)

    const doneCall = await waitForCallback('/internal/stream/on-publish-done')

    expect(doneCall.body.name).toBe('lifecycle-key')
    expect(doneCall.body.app).toBe('live')
  })

  it('on_publish fires before on_publish_done', async () => {
    await pushStream('lifecycle-key', 2)

    await waitForCallback('/internal/stream/on-publish-done')

    const state = await getMockApiState()
    const publishTs = state.calls.find((c) => c.path === '/internal/stream/on-publish')?.timestamp
    const doneTs = state.calls.find((c) => c.path === '/internal/stream/on-publish-done')?.timestamp

    expect(publishTs).toBeDefined()
    expect(doneTs).toBeDefined()
    expect(publishTs).toBeLessThan(doneTs!)
  })
})
