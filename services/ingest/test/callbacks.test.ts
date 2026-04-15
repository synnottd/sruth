import { describe, it, expect, beforeEach } from 'vitest'
import { pushStream } from './helpers/rtmp.js'
import { resetMockApi, getMockApiState, waitForCallback } from './helpers/mock-api.js'

describe('MediaMTX lifecycle callbacks', () => {
  beforeEach(() => resetMockApi(200))

  it('fires on_publish when a stream connects', async () => {
    await pushStream('lifecycle-key', 2)

    const publishCall = await waitForCallback('/internal/stream/on-publish')

    expect(publishCall.body.name).toBe('lifecycle-key')
    expect(publishCall.body.app).toBe('live')
  })
})
