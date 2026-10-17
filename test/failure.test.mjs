// Failure semantics: a dead chain must return a routable code and tell the model
// NOT to retry a reworded question. This is the DVR contract that matters most.
import { createVisionEngine } from '../extensions/engine.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bytes = readFileSync(path.join(here, '..', 'test-fixtures', 'probe.png'))

// A loopback-only provider list pointing at a closed port: localOnly filters the
// free chain away, so every candidate fails fast.
const engine = createVisionEngine({
  settings: () => ({
    localOnly: true,
    httpProviders: [
      { name: 'dead', model: 'dead-model', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: '', maxTokens: 16 },
    ],
    perProviderTimeoutMs: 3000,
    taskTimeoutMs: 6000,
  }),
})

if (engine.candidates().length !== 1) {
  throw new Error(`localOnly should leave exactly the dead provider, got ${engine.candidates().length}`)
}

const first = await engine.ask([{ bytes, mediaType: 'image/png' }], 'anything', { scope: 'fail:1' })
console.log('first  ->', JSON.stringify({ ok: first.ok, code: first.code, retryable: first.retryable }))
console.log('attempted:', JSON.stringify(first.attemptedProviders ?? null))

// Second call in the same turn must not re-burn the chain.
const second = await engine.ask([{ bytes, mediaType: 'image/png' }], 'reworded question', { scope: 'fail:1' })
console.log('second ->', JSON.stringify({ ok: second.ok, code: second.code, retryable: second.retryable }))

if (first.ok !== false) throw new Error('expected ok:false from a dead chain')
if (typeof first.code !== 'string' || first.code === '') throw new Error('expected a routable code')
if (first.retryable !== false) throw new Error('expected retryable:false')
// The attempt log proves the chain was actually walked and classified, not that
// the failure was synthesized before any backend was contacted.
if (!Array.isArray(first.attemptedProviders) || first.attemptedProviders.length === 0) {
  throw new Error('expected an attempt record on the failure')
}
if (first.attemptedProviders.every((a) => a.skipped === true)) {
  throw new Error(`expected a contacted backend, got only skips: ${JSON.stringify(first.attemptedProviders)}`)
}
if (first.attemptedProviders.some((a) => typeof a.kind !== 'string' || a.kind === '')) {
  throw new Error(`expected every attempt to carry a classified kind: ${JSON.stringify(first.attemptedProviders)}`)
}
if (second.code !== 'VISION_BACKEND_UNAVAILABLE_THIS_TURN') {
  throw new Error(`expected the this-turn short circuit, got ${second.code}`)
}
console.log('FAILURE SEMANTICS OK')
