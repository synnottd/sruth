import { execa } from 'execa'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const composeFile = path.resolve(__dirname, '../docker-compose.yml')

export async function setup() {
  try {
    await execa('ffmpeg', ['-version'])
  } catch {
    throw new Error('ffmpeg is required to run ingest tests but was not found on PATH')
  }

  await execa('docker', ['compose', '-f', composeFile, 'up', '--build', '-d'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitForServices()
}

export async function teardown() {
  await execa('docker', ['compose', '-f', composeFile, 'down', '--volumes'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
}

async function waitForServices() {
  await Promise.all([
    waitForHttp('http://127.0.0.1:3001/health', 'mock-api'),
    waitForHttp('http://127.0.0.1:8080/health', 'ingest'),
  ])
}

async function waitForHttp(url: string, name: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Service "${name}" not ready at ${url} after ${timeoutMs}ms`)
}
