// A local OpenAI-compatible endpoint that answers vision requests with a fixed
// reply. Tests point the chain at it (localOnly + httpProviders) so the suite is
// deterministic and runs in CI with no network and no dependency on a free tier.
import { createServer } from 'node:http'

export const MOCK_ANSWER = 'MOCK VISION ANSWER'

/**
 * Start the mock. `reply` may be a string or a function of the parsed request.
 * Returns { url, baseURL, close, hits } -- point a provider's baseURL at
 * `${url}/v1`.
 */
export async function startMockChain({ reply = MOCK_ANSWER, status = 200, delayMs = 0, contentType } = {}) {
  const hits = []

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = { raw: body }
      }
      hits.push({ url: req.url, headers: req.headers, body: parsed })

      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))

      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock status ${status}` } }))
        return
      }

      const text = typeof reply === 'function' ? reply(parsed, hits.length) : reply
      res.writeHead(200, { 'content-type': contentType ?? 'application/json' })
      res.end(JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}`

  return {
    url,
    baseURL: `${url}/v1`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Provider row for `settings.httpProviders` that targets a running mock. */
export function mockProvider(mock, overrides = {}) {
  return {
    name: 'mock',
    model: 'mock-vision',
    baseURL: mock.baseURL,
    apiKeyEnv: '',
    maxTokens: 128,
    ...overrides,
  }
}

/** Settings that make the engine use ONLY the given mock. */
export function mockSettings(mock, extra = {}) {
  return {
    localOnly: true,
    httpProviders: [mockProvider(mock)],
    perProviderTimeoutMs: 10_000,
    taskTimeoutMs: 20_000,
    ...extra,
  }
}
