// Offline end-to-end: engine, tool layer and failure paths against a local mock
// chain. No network, no credentials, deterministic -- this is the CI suite.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockChain, mockSettings, MOCK_ANSWER } from './mock-chain.mjs'
import { createVisionEngine } from '../extensions/engine.js'
import { buildTools } from '../extensions/tools.js'
import * as P from '../extensions/vendor/primitives.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const probe = readFileSync(path.join(here, '..', 'test-fixtures', 'probe.png'))

function harness(settings) {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'pvr-offline-'))
  const engine = createVisionEngine({ settings: () => settings })
  const ctx = {
    settings,
    engine,
    cwd: path.join(here, '..', 'test-fixtures'),
    artifactsDir,
    resolveCache: () => undefined,
    scope: () => 'offline:1',
    createDeadline: () => P.createDeadline(settings.taskTimeoutMs ?? 20_000),
  }
  return { engine, ctx, tools: buildTools(ctx), artifactsDir }
}

const textOf = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

// --- 1. The chain answers from the mock, and sends the image as a data URL ---
{
  const mock = await startMockChain()
  try {
    const settings = mockSettings(mock)
    const { engine } = harness(settings)
    const result = await engine.ask([{ bytes: probe, mediaType: 'image/png' }], 'what is here', { scope: 'offline:1' })
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`)
    assert.equal(result.text, MOCK_ANSWER)
    assert.equal(result.provider.startsWith('mock/mock-vision@'), true)

    const request = mock.hits[0].body
    const content = request.messages[0].content
    const image = content.find((c) => c.type === 'image_url')
    assert.ok(image, 'image was not sent')
    assert.match(image.image_url.url, /^data:image\/png;base64,/)
    // A keyless provider must not send an Authorization header.
    assert.equal(mock.hits[0].headers.authorization, undefined)
    console.log('ok  chain answers through the mock')
  } finally {
    await mock.close()
  }
}

// --- 2. Tool layer end-to-end: schema, resolver, engine, structured result ---
{
  const mock = await startMockChain()
  try {
    const settings = mockSettings(mock)
    const { tools } = harness(settings)
    const describe = tools.find((t) => t.name === 'vision_describe')
    const out = await describe.execute('t1', { paths: ['probe.png'], question: 'describe' }, undefined, undefined, undefined)
    assert.match(textOf(out), new RegExp(MOCK_ANSWER))
    assert.equal(out.isError, undefined)
    console.log('ok  vision_describe resolves a path and answers')
  } finally {
    await mock.close()
  }
}

// --- 3. A 429 must classify as RATE_LIMIT and not be retried inside the call ---
{
  const mock = await startMockChain({ status: 429 })
  try {
    const settings = mockSettings(mock)
    const { engine } = harness(settings)
    const result = await engine.ask([{ bytes: probe, mediaType: 'image/png' }], 'x', { scope: 'offline:429' })
    assert.equal(result.ok, false)
    assert.equal(result.retryable, false)
    assert.equal(mock.hits.length, 1, 'a 429 must not be retried within the call')
    assert.equal(result.attemptedProviders[0].kind, 'RATE_LIMIT')
    console.log('ok  429 -> RATE_LIMIT, single attempt, retryable:false')
  } finally {
    await mock.close()
  }
}

// --- 4. Fallback: a dead first provider fails over to a healthy second one ---
{
  const good = await startMockChain({ reply: 'SECOND BACKEND ANSWER' })
  const settings = {
    httpProviders: [
      { name: 'dead', model: 'dead', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: '', maxTokens: 16 },
      { name: 'mock', model: 'mock-vision', baseURL: good.baseURL, apiKeyEnv: '', maxTokens: 128 },
    ],
    perProviderTimeoutMs: 5_000,
    taskTimeoutMs: 20_000,
  }
  try {
    const { engine } = harness(settings)
    // Both providers reachable in the pool; the free chain is appended after
    // them, and must not be reached because the mock answers first.
    const result = await engine.ask([{ bytes: probe, mediaType: 'image/png' }], 'x', { scope: 'offline:fb' })
    assert.equal(result.ok, true, `expected fallback success, got ${JSON.stringify(result)}`)
    assert.equal(result.text, 'SECOND BACKEND ANSWER')
    assert.equal(good.hits.length, 1)
    console.log('ok  dead provider falls through to the healthy one')
  } finally {
    await good.close()
  }
}

// --- 5. An empty answer is a failure, not a silent success ---
{
  const mock = await startMockChain({ reply: '   ' })
  try {
    const settings = mockSettings(mock)
    const { engine } = harness(settings)
    const result = await engine.ask([{ bytes: probe, mediaType: 'image/png' }], 'x', { scope: 'offline:empty' })
    assert.equal(result.ok, false, 'a blank answer must not be reported as success')
    assert.equal(result.retryable, false)
    console.log('ok  blank answer treated as failure')
  } finally {
    await mock.close()
  }
}

console.log('OFFLINE SUITE OK')
