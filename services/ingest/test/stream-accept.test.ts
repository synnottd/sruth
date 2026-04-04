import { describe, it, expect, beforeEach } from 'vitest'
import { pushStream } from './helpers/rtmp.js'
import { resetMockApi, getMockApiState } from './helpers/mock-api.js'

describe('stream acceptance', () => {
  beforeEach(() => resetMockApi(200))

  it('accepts a stream when on_publish returns 200', async () => {
    const result = await pushStream('valid-key', 3)

    // ffmpeg exit 0 means it streamed for the full duration without being disconnected
    expect(result.exitCode).toBe(0)
  })

  it('on_publish callback is fired when a stream connects', async () => {
    await pushStream('valid-key', 2)

    const state = await getMockApiState()
    const call = state.calls.find((c) => c.path === '/internal/stream/on-publish')

    expect(call).toBeDefined()
  })

  it('on_publish callback contains the stream key and app name', async () => {
    await pushStream('my-stream-key', 2)

    const state = await getMockApiState()
    const call = state.calls.find((c) => c.path === '/internal/stream/on-publish')

    expect(call!.body.name).toBe('my-stream-key')
    expect(call!.body.app).toBe('live')
  })
})
