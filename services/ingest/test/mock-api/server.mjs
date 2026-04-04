import http from 'http'

const PORT = 3001

let config = { onPublishStatus: 200 }
const calls = []

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const body = await readBody(req)

  if (req.method === 'POST' && url.pathname === '/internal/stream/on-publish') {
    const params = new URLSearchParams(body)
    calls.push({
      path: url.pathname,
      timestamp: Date.now(),
      body: Object.fromEntries(params),
    })
    console.log(`[mock-api] on_publish: key=${params.get('name')} → ${config.onPublishStatus}`)
    res.writeHead(config.onPublishStatus)
    res.end()
    return
  }

  if (req.method === 'POST' && url.pathname === '/internal/stream/on-publish-done') {
    const params = new URLSearchParams(body)
    calls.push({
      path: url.pathname,
      timestamp: Date.now(),
      body: Object.fromEntries(params),
    })
    console.log(`[mock-api] on_publish_done: key=${params.get('name')}`)
    res.writeHead(200)
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/test/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ calls, config }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/test/reset') {
    calls.length = 0
    res.writeHead(200)
    res.end()
    return
  }

  if (req.method === 'POST' && url.pathname === '/test/configure') {
    Object.assign(config, JSON.parse(body || '{}'))
    res.writeHead(200)
    res.end()
    return
  }

  if (url.pathname === '/health') {
    res.writeHead(200)
    res.end('ok')
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => {
  console.log(`[mock-api] listening on port ${PORT}`)
})
