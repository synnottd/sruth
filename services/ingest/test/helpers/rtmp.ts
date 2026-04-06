import { execa } from 'execa'

const INGEST_HOST = '127.0.0.1'
const INGEST_PORT = 1935

function rtmpUrl(key: string): string {
  return `rtmp://${INGEST_HOST}:${INGEST_PORT}/live/${key}`
}

function pushArgs(key: string, durationSeconds: number): string[] {
  return [
    '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '200k', '-g', '30',
    '-c:a', 'aac', '-b:a', '32k', '-ar', '44100',
    '-t', String(durationSeconds),
    '-f', 'flv', rtmpUrl(key),
  ]
}

export interface PushResult {
  exitCode: number | null
  stderr: string
}

/**
 * Push a test stream for a fixed duration and wait for it to finish.
 * exitCode 0 = stream completed normally (accepted by ingest).
 * exitCode non-0 = rejected or disconnected.
 */
export async function pushStream(key: string, durationSeconds: number): Promise<PushResult> {
  const result = await execa('ffmpeg', pushArgs(key, durationSeconds), { reject: false })
  return { exitCode: result.exitCode ?? null, stderr: result.stderr }
}

/**
 * Start a long-running push stream in the background.
 * Returns stop() to kill it and done to await the result.
 */
export function startPushStream(key: string): { stop: () => void; done: Promise<PushResult> } {
  const subprocess = execa('ffmpeg', pushArgs(key, 300), { reject: false })
  const done = subprocess.then((r) => ({ exitCode: r.exitCode ?? null, stderr: r.stderr }))
  return {
    stop: () => { subprocess.kill('SIGTERM') },
    done,
  }
}

/**
 * Check whether a stream is currently live on the ingest server.
 * Uses the nginx-rtmp stat endpoint — no ffmpeg required.
 */
export async function probeStream(key: string, timeoutSeconds = 5): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${INGEST_HOST}:8080/stat`)
      if (res.ok) {
        const xml = await res.text()
        if (xml.includes(`<name>${key}</name>`)) return true
      }
    } catch (err: unknown) {
      const cause = (err as any)?.cause?.code
      if (cause !== 'ECONNREFUSED' && cause !== 'ECONNRESET') {
        console.error(`[probeStream] unexpected error:`, err)
      }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}
