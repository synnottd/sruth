const MOCK_API = 'http://127.0.0.1:3001'

export { MOCK_API }

export async function resetMockApi(onPublishStatus = 200) {
  await fetch(`${MOCK_API}/test/reset`, { method: 'POST' })
  await fetch(`${MOCK_API}/test/configure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onPublishStatus }),
  })
}

export async function getMockApiState() {
  return fetch(`${MOCK_API}/test/state`).then((r) => r.json()) as Promise<MockApiState>
}

export interface MockApiCall {
  path: string
  timestamp: number
  body: Record<string, string>
}

export interface MockApiState {
  calls: MockApiCall[]
  config: { onPublishStatus: number }
}
