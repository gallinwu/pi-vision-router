// Vision engine for pi-vision-router: the OpenAI-compatible provider chain,
// circuit breaker, per-turn failure memory and shared deadline, ported from
// dsh-vision-router's core-primitives + vision-resilience. No DSH services.
import { createHash } from 'node:crypto'
import {
  classifyVisionFailure,
  createVisionCircuitBreaker,
  createVisionTurnMemory,
  resultCodeForKinds,
  VISION_RESULT_CODES,
  VISION_DO_NOT_RETRY_ADVICE,
  kindForHttpStatus,
  qwenKeyEndpointHint,
  buildVisionFailure,
  combineSignals,
} from './vendor/vision-resilience.js'
import { fetchWithOpenAICompatibility, readResponseTextLimited } from './vendor/http-compat.js'
import { stripTrailingSlashes } from './vendor/string-normalization.js'

// OVH anonymous quota is per IP AND per model: order largest -> smallest so a
// 429 on one model falls through to the next model's independent bucket.
export const DEFAULT_HTTP_PROVIDERS = [
  { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'Qwen3.5-397B-A17B', apiKeyEnv: '', maxTokens: 4096 },
  { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'Qwen2.5-VL-72B-Instruct', apiKeyEnv: '', maxTokens: 4096 },
  { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'Qwen3.6-27B', apiKeyEnv: '', maxTokens: 4096 },
  { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'Mistral-Small-3.2-24B-Instruct-2506', apiKeyEnv: '', maxTokens: 4096 },
  { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'Qwen3.5-9B', apiKeyEnv: '', maxTokens: 4096 },
]

export function providerIdentity(provider) {
  return `${provider.name}/${provider.model}@${stripTrailingSlashes(provider.baseURL ?? '')}`
}

export function resolveProviders(settings = {}) {
  const configured = Array.isArray(settings.httpProviders) ? settings.httpProviders : []
  if (settings.localOnly === true) {
    return configured.filter((p) => /@https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(providerIdentity(p)))
  }
  if (configured.length === 0) return DEFAULT_HTTP_PROVIDERS
  const seen = new Set(configured.map((p) => `${p.name}/${p.model}`))
  return [
    ...configured,
    ...DEFAULT_HTTP_PROVIDERS.filter((p) => !seen.has(`${p.name}/${p.model}`)),
  ]
}

export function resolveCredential(apiKeyEnv, getApiKey) {
  if (process.env[apiKeyEnv]) return process.env[apiKeyEnv]
  if (typeof getApiKey === 'function') {
    try {
      const value = getApiKey()
      if (typeof value === 'string' && value !== '') return value
    } catch {
      // Registry lookup failures degrade to "not configured", never a crash.
    }
  }
  return ''
}

/**
 * One non-streaming OpenAI-compatible chat completion. Keyless when apiKeyEnv
 * is empty. A 429 throws IMMEDIATELY with Retry-After attached -- never a blind
 * wait that stacks up across providers.
 */
export async function callOpenAICompatible(provider, messages, options = {}) {
  const headers = { 'content-type': 'application/json' }
  const apiKeyEnv = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : ''
  let resolvedApiKey = ''
  if (apiKeyEnv !== '') {
    resolvedApiKey = resolveCredential(apiKeyEnv, options.resolveCredential)
    if (resolvedApiKey === '') {
      const error = new Error(`http provider "${provider.name}": ${apiKeyEnv} is not set`)
      error.code = 'NO_CREDENTIAL'
      throw error
    }
    headers.authorization = `Bearer ${resolvedApiKey}`
  }
  const body = {
    model: provider.model,
    messages,
    max_tokens: options.maxTokens ?? provider.maxTokens ?? 4096,
    stream: false,
  }
  const url = `${stripTrailingSlashes(provider.baseURL)}/chat/completions`
  const response = await fetchWithOpenAICompatibility(
    fetch,
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    { active: true, providerName: provider.name },
  )
  if (!response.ok) {
    const detail = await readResponseTextLimited(response, 64 * 1024).catch(() => '')
    const retryAfter = Number(response.headers.get('retry-after'))
    const error = new Error(`http provider "${provider.name}": ${response.status} ${String(detail).slice(0, 300)}`)
    error.status = response.status
    error.code = kindForHttpStatus(response.status) ?? 'HTTP_PROVIDER_FAILED'
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      error.providerRetryAfterMs = Math.min(retryAfter * 1000, 60 * 60 * 1000)
    }
    const keyHint = qwenKeyEndpointHint(provider.baseURL, resolvedApiKey)
    if (keyHint !== '') error.message += keyHint
    throw error
  }
  const data = await response.json().catch(() => undefined)
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error(`http provider "${provider.name}": unexpected response shape`)
  }
  return content.trim()
}

/** OpenAI image content blocks from raw bytes. */
export function toOpenAIImageContent(images, promptText) {
  const blocks = images.map((image) => ({
    type: 'image_url',
    image_url: {
      url: `data:${image.mediaType || 'image/png'};base64,${Buffer.from(image.bytes).toString('base64')}`,
    },
  }))
  if (typeof promptText === 'string' && promptText !== '') blocks.push({ type: 'text', text: promptText })
  return blocks
}

export function createVisionEngine({ settings, getApiKey, log } = {}) {
  const breaker = createVisionCircuitBreaker({})
  const turnMemory = createVisionTurnMemory({})
  const fingerprints = new Map()

  const snapshot = () => (typeof settings === 'function' ? settings() : settings) ?? {}

  function credentialOf(provider) {
    const env = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : ''
    if (env === '') return 'keyless'
    const value = resolveCredential(env, () => (typeof getApiKey === 'function' ? getApiKey(env) : ''))
    return value === '' ? 'unresolved' : createHash('sha256').update(value).digest('hex').slice(0, 16)
  }

  function candidates() {
    const config = snapshot()
    const chain = resolveProviders(config)
    const explicit = typeof config.model === 'string' && config.model !== '' ? config.model : undefined
    if (!explicit) return chain
    const preferred = chain.filter((p) => `${p.name}/${p.model}` === explicit || p.model === explicit)
    return [...preferred, ...chain.filter((p) => !preferred.includes(p))]
  }

  /**
   * Ask the vision chain about images. Returns { ok:true, text, provider } or
   * the structured { ok:false, code, ... } failure the agent is told about.
   */
  async function ask(images, promptText, options = {}) {
    const config = snapshot()
    const scope = options.scope ?? 'default'
    const deadline = options.deadline
    if (images.length === 0) {
      return { ok: false, code: 'VISION_NO_IMAGE', retryable: false, reason: 'no image bytes were supplied' }
    }
    if (config.turnMemory !== false && turnMemory.allFailed(scope)) {
      return {
        ok: false,
        code: VISION_RESULT_CODES.BACKEND_UNAVAILABLE_THIS_TURN,
        retryable: false,
        knownKinds: turnMemory.failedKinds(scope),
        reason: 'every configured vision backend already failed this turn; no new network attempt was made',
        advice: VISION_DO_NOT_RETRY_ADVICE,
      }
    }

    const pool = candidates()
    if (pool.length === 0) {
      return { ok: false, code: VISION_RESULT_CODES.UNSUPPORTED_BACKEND, retryable: false, reason: 'no vision provider is configured' }
    }
    const attempts = []
    // Per-provider time slice of the ONE shared deadline: chained backends can
    // never multiply the total wait into minutes.
    const perProviderMs = Number.isFinite(config.perProviderTimeoutMs) ? config.perProviderTimeoutMs : 60000

    for (const provider of pool) {
      if (options.signal?.aborted === true) {
        return { ok: false, code: 'VISION_ABORTED', retryable: false, reason: 'the turn was aborted', attempts }
      }
      const identity = providerIdentity(provider)
      const fingerprint = fingerprints.get(identity) ?? credentialOf(provider)
      fingerprints.set(identity, fingerprint)
      const blocked = breaker.inspect(identity, fingerprint, scope)
      if (blocked.blocked) {
        attempts.push({ provider: identity, skipped: true, reason: blocked.reason })
        continue
      }
      const left = deadline ? deadline.remaining() : perProviderMs
      if (deadline && left <= 0) {
        attempts.push({ provider: identity, skipped: true, reason: 'deadline' })
        continue
      }
      const slice = Math.max(1, Math.min(perProviderMs, left))
      const signal = combineSignals(options.signal, AbortSignal.timeout(slice))
      try {
        const text = await callOpenAICompatible(
          provider,
          [{ role: 'user', content: toOpenAIImageContent(images, promptText) }],
          {
            signal,
            resolveCredential: (env) => (typeof getApiKey === 'function' ? getApiKey(env) : undefined),
            maxTokens: provider.maxTokens ?? config.maxTokens ?? 4096,
          },
        )
        if (text === '') throw new Error('vision backend returned an empty answer')
        return { ok: true, text, provider: identity, attempts }
      } catch (error) {
        const classification = classifyVisionFailure(error)
        breaker.record(identity, fingerprint, classification, scope)
        turnMemory.record(scope, identity, classification.kind)
        attempts.push({
          provider: identity,
          kind: classification.kind,
          message: String(error?.message ?? error).slice(0, 240),
        })
        if (options.signal?.aborted === true) {
          return { ok: false, code: 'VISION_ABORTED', retryable: false, reason: 'the turn was aborted', attempts }
        }
      }
    }

    const kinds = [...new Set(attempts.filter((a) => !a.skipped && a.kind).map((a) => a.kind))]
    const anyNetworkFailure = kinds.length > 0
    if (anyNetworkFailure) {
      turnMemory.markAllFailed(scope)
      // Retry the same turn is pointless, so subsequent calls short-circuit.
      try {
        turnMemory.bindSession?.('session', scope)
      } catch {
        // binding is best effort
      }
    }
    return buildVisionFailure({
      code: anyNetworkFailure
        ? resultCodeForKinds(kinds)
        : VISION_RESULT_CODES.BACKEND_UNAVAILABLE,
      retryable: false,
      reason: anyNetworkFailure
        ? 'all configured vision backends failed'
        : 'every vision backend is on cooldown (rate limit or auth trip); none were attempted this call',
      attempted: attempts,
    })
  }

  function resetTurn(scope) {
    try {
      breaker.reset()
    } catch {
      // reset is best effort
    }
    turnMemory.reset?.()
    void scope
  }

  return { ask, candidates, breaker, turnMemory, snapshot, resetTurn, credentialOf }
}
