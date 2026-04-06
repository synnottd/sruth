import { describe, it, expect, beforeEach } from 'vitest'
import { startPushStream, probeStream } from './helpers/rtmp.js'
import { resetMockApi } from './helpers/mock-api.js'

describe('stream passthrough', () => {
  beforeEach(() => resetMockApi(200))

  it('a stream pushed to ingest is readable as RTMP output', async () => {
    // This mirrors what the worker does: pull from rtmp://{ingest-ip}/live/{key}
    const { stop, done } = startPushStream('passthrough-key')

    try {
      // Wait for the stream to be established before probing
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const readable = await probeStream('passthrough-key')
      expect(readable).toBe(true)
    } finally {
      stop()
      await done
    }
  })

  it('stream is no longer readable after the publisher disconnects', async () => {
    const { stop, done } = startPushStream('passthrough-key')

    // Let it get established
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await probeStream('passthrough-key')).toBe(true)

    // Disconnect the publisher
    stop()
    await done

    // Brief wait for nginx-rtmp to close the stream
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(await probeStream('passthrough-key', 3)).toBe(false)
  })
})
