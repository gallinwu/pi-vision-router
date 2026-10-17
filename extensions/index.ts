// pi-vision-router: DSH vision-router ported to the Pi extension runtime.
//
// Parity map (DVR -> Pi):
//   ctx.tools.register(def)            -> pi.registerTool(defineTool(def))
//   ctx.llm.registerAdapter(chain)     -> pi.registerProvider('vision-chain', {...})
//   ctx.get('attachments') store       -> per-turn image cache + artifacts dir
//   ctx.get('settings') namespace      -> own JSON file (~/.pi/agent/vision-router.json)
//   session image turns                -> before_agent_start guidance injection
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import * as P from './vendor/primitives.js'
import { createVisionEngine, resolveProviders } from './engine.js'
import { buildTools } from './tools.js'

const SETTINGS_FILE = process.env.PI_VISION_SETTINGS
  ?? path.join(homedir(), '.pi', 'agent', 'vision-router.json')

const DEFAULTS = {
  tool: true,
  progressiveTools: true,
  autoActivateOnImage: true,
  routing: false,
  // OFF by default: registering the keyless chain as a selectable provider makes
  // Pi willing to pick it as the SESSION model, and then every ordinary chat turn
  // goes through the anonymous tier -- which 403s on any Authorization header and
  // is far too small to drive an agent. The vision tools do not need this at all;
  // the chain is reached through the engine. Opt in with
  // /vision set exposeChainProvider=true when you want those models by name.
  exposeChainProvider: false,
  desktopScreenshot: false,
  ocrEngine: 'auto',
  model: '',
  httpProviders: [],
  localOnly: false,
  turnMemory: true,
  downscale: true,
  downscaleMaxPixels: P.SHARP_MAX_PIXELS,
  taskTimeoutMs: 120000,
  perProviderTimeoutMs: 60000,
  artifactsDir: '',
}

const CHAIN_PROVIDER = 'vision-chain'
// Placeholder that satisfies Pi's "provider must have a key" check; the
// before_provider_headers hook deletes the resulting Authorization header so the
// anonymous endpoint never sees it.
const KEYLESS_SENTINEL = 'pi-vision-router-keyless'

function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function writeSettings(next) {
  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  const body = JSON.stringify(next, null, 2)
  // Keep the previous file as .bak, then replace atomically: a half-written
  // settings file must never poison the next load.
  try {
    if (existsSync(SETTINGS_FILE)) writeFileSync(`${SETTINGS_FILE}.bak`, readFileSync(SETTINGS_FILE), 'utf8')
  } catch {
    // backup is best effort
  }
  const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, body, 'utf8')
  try {
    renameSync(tmp, SETTINGS_FILE)
  } catch {
    // Some Windows states reject rename-over-existing; fall back to a direct write.
    writeFileSync(SETTINGS_FILE, body, 'utf8')
    try {
      rmSync(tmp)
    } catch {
      // ignore
    }
  }
  return next
}

export default function visionRouter(pi) {
  let settings = readSettings()
  const artifactsDir = () =>
    settings.artifactsDir && settings.artifactsDir !== ''
      ? path.resolve(artifactsDirRoot(settings.artifactsDir))
      : path.join(tmpdir(), 'pi-vision-router', 'artifacts')

  function artifactsDirRoot(value) {
    return path.isAbsolute(value) ? value : value
  }

  // Per-turn image cache: Pi hands extension events base64 ImageContent, and
  // tools address them as turn:<n>:<i>. Nothing is dropped into a temp store.
  let turnCounter = 0
  const imageCache = new Map()
  const putTurnImages = (images) => {
    const turn = ++turnCounter
    const ids = []
    for (let index = 0; index < images.length; index++) {
      const image = images[index]
      if (!image || image.type !== 'image' || typeof image.data !== 'string') continue
      const id = `turn:${turn}:${index}`
      imageCache.set(id, { bytes: Buffer.from(image.data, 'base64'), mediaType: image.mimeType || 'image/png' })
      ids.push(id)
      while (imageCache.size > 24) imageCache.delete(imageCache.keys().next().value)
    }
    return { turn, ids }
  }

  const engine = createVisionEngine({
    settings: () => settings,
    // Provider credentials: DVR reads its own apiKeyEnv names; in Pi the user
    // can export them, or point the same env name at a value in the settings.
    getApiKey: (env) => (typeof settings.apiKeys?.[env] === 'string' ? settings.apiKeys[env] : process.env[env]),
  })

  const ctx = {
    get settings() {
      return settings
    },
    engine,
    cwd: process.cwd(),
    get artifactsDir() {
      return artifactsDir()
    },
    resolveCache: (id) => imageCache.get(id),
    scope: (runCtx) => `${runCtx?.sessionManager?.getSessionId?.() ?? 'local'}:${turnCounter}`,
    createDeadline: () => P.createDeadline(settings.taskTimeoutMs ?? 120000),
  }

  const tools = buildTools(ctx)
  const registered = new Set()
  // Progressive exposure mirrors DVR: describe + materialize stay live, the
  // deep set joins on an image turn or an explicit vision_activate call.
  const mount = (names) => {
    for (const tool of tools) {
      if (names && !names.includes(tool.name)) continue
      if (registered.has(tool.name)) continue
      pi.registerTool(tool)
      registered.add(tool.name)
    }
  }

  const ACTIVATION = tools
    .filter((t) => t.name !== 'vision_describe')
    .map((t) => t.name)

  mount(settings.progressiveTools ? ['vision_describe', 'vision_materialize'] : undefined)

  const activateTool = defineTool({
    name: 'vision_activate',
    label: 'vision activate',
    description:
      'Mount the deep vision tools for this session: ' +
      ACTIVATION.filter((n) => n !== 'vision_screenshot' || settings.desktopScreenshot === true).join(', ') +
      '. They mount automatically on image turns; call this only on a text-only turn.',
    parameters: Type.Object({}),
    async execute() {
      mount()
      return {
        content: [{ type: 'text', text: `vision deep tools mounted: ${tools.map((t) => t.name).join(', ')}` }],
        details: { mounted: tools.map((t) => t.name) },
      }
    },
  })
  pi.registerTool(activateTool)

  // ── Free vision chain exposed as selectable Pi models (DVR chain route) ──
  function syncChainProvider() {
    if (settings.exposeChainProvider === false) {
      try {
        pi.unregisterProvider(CHAIN_PROVIDER)
      } catch {
        // never registered
      }
      return
    }
    const providers = resolveProviders(settings)
    pi.registerProvider(CHAIN_PROVIDER, {
      name: 'Vision Chain (dsh-vision-router port)',
      baseUrl: providers[0]?.baseURL,
      // Pi refuses to send a request whose provider has no key at all
      // (assertRequestAuth), but the anonymous OVH tier rejects ANY
      // Authorization header with "403 authentication failed". So the registry
      // gets a sentinel to satisfy the check, and the before_provider_headers
      // hook below strips the header off the wire. Verified against the live
      // endpoint: same request 200 without the header, 403 with it.
      apiKey: KEYLESS_SENTINEL,
      api: 'openai-completions',
      models: providers.map((provider) => ({
        id: provider.model,
        name: `${provider.name}: ${provider.model}`,
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: provider.maxTokens ?? 4096,
      })),
    })
  }
  syncChainProvider()

  // Keep the keyless chain actually keyless: delete the Authorization header the
  // sentinel above makes Pi assemble. The event carries no provider field, so the
  // match is on the sentinel value itself -- a real provider's own credential is
  // never touched.
  pi.on('before_provider_headers', (event) => {
    if (settings.exposeChainProvider === false) return
    const headers = event.headers as Record<string, unknown> | undefined
    if (!headers) return
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() !== 'authorization') continue
      if (String(headers[name] ?? '').includes(KEYLESS_SENTINEL)) headers[name] = null
    }
  })

  // ── Image-turn bridge: text-only session models get eyes via the tools ──
  pi.on('before_agent_start', async (event, runCtx) => {
    const images = Array.isArray(event.images) ? event.images : []
    const acceptsImages = runCtx?.model?.input?.includes?.('image') === true
    if (images.length === 0) return undefined
    const { ids } = putTurnImages(images)
    if (settings.autoActivateOnImage !== false) mount()
    if (acceptsImages && settings.routing !== true) {
      // The native multimodal path already sees the pixels; the tools remain
      // available as an optional second look, so only mount them.
      return undefined
    }
    const textOnly = settings.visionDepth === 'deep'
      ? 'Inspect it with vision_describe, then verify any decisive claim with vision_ground, vision_crop or vision_ocr before answering.'
      : 'Answer with vision_describe (question-specific), and use vision_ocr only when exact verbatim text is required.'
    return {
      message: {
        customType: 'vision-router',
        display: false,
        content: [
          {
            type: 'text',
            text:
              `[vision-router] ${ids.length} image(s) arrived on a turn the current model cannot read natively. ` +
              `They are cached as: ${ids.join(', ')}. ${textOnly} ` +
              'Do not guess their content from filenames.',
          },
        ],
        details: { imageIds: ids, nativeVision: acceptsImages },
      },
    }
  })

  pi.on('turn_end', async () => {
    // One turn memory per user turn: after a full backend failure the model is
    // answered from memory instead of re-burning the chain.
    if (settings.turnMemory !== false) engine.turnMemory.bindSession?.('session', ctx.scope())
  })

  // ── /vision ──
  pi.registerCommand('vision', {
    description: 'Vision Router status and settings (status | enable <tool> | set <k=v> | providers | reset)',
    handler: async (args, runCtx) => {
      const parts = String(args ?? '').trim().split(/\s+/)
      const verb = parts[0]
      const notify = (text, level = 'info') => runCtx?.ui?.notify?.(text, level)

      if (verb === 'set') {
        for (const pair of parts.slice(1)) {
          const index = pair.indexOf('=')
          if (index <= 0) continue
          const key = pair.slice(0, index)
          const raw = pair.slice(index + 1)
          const value = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : raw
          settings = writeSettings({ ...settings, [key]: value })
          syncChainProvider()
          if (key === 'desktopScreenshot') {
            // vision_screenshot mounts only when its toggle is on, so the tool
            // list has to be rebuilt. Already-registered names stay registered.
            const rebuilt = buildTools(ctx)
            tools.length = 0
            tools.push(...rebuilt)
            if (value === true) mount(['vision_screenshot'])
          }
          notify(`vision ${key} = ${String(value)}`)
        }
        return
      }
      if (verb === 'providers') {
        const list = engine.candidates()
        notify(list.map((p, i) => `${i + 1}. ${p.name}/${p.model}`).join('\n') || 'no providers')
        return
      }
      if (verb === 'reset') {
        settings = writeSettings({ ...DEFAULTS })
        engine.breaker.reset()
        engine.turnMemory.reset()
        syncChainProvider()
        notify('vision-router settings reset to defaults')
        return
      }
      if (verb === 'enable') {
        mount([parts[1]].filter(Boolean))
        notify(`mounted ${parts[1] ?? '(nothing)'}`)
        return
      }
      const tesseract = P.hasTesseract()
      notify(
        [
          `tool=${settings.tool} progressive=${settings.progressiveTools} routing=${settings.routing}`,
          `desktopScreenshot=${settings.desktopScreenshot} ocrEngine=${settings.ocrEngine} (tesseract ${tesseract ? 'found' : 'missing'})`,
          `providers=${engine.candidates().length} active=${[...registered].length}`,
          `settings=${SETTINGS_FILE}`,
        ].join('\n'),
      )
    },
  })

  pi.registerCommand('see', {
    description: 'Ask the vision chain about an image file or a cached turn image: /see <path|turn:1:0> <question>',
    handler: async (args, runCtx) => {
      const rest = String(args ?? '').trim()
      const first = rest.split(/\s+/)[0]
      const question = rest.slice(first.length).trim() || 'Describe this image accurately, reading order first.'
      if (!first) {
        runCtx?.ui?.notify?.('usage: /see <image path or turn:<n>:<i>> <question>', 'warning')
        return
      }
      mount()
      const describe = tools.find((t) => t.name === 'vision_describe')
      const result = await describe.execute('cmd', { paths: [first], question, json: false }, runCtx?.signal, undefined, runCtx)
      runCtx?.ui?.notify?.(String(result?.content?.[0]?.text ?? '(no answer)').slice(0, 2000), 'info')
    },
  })
}
