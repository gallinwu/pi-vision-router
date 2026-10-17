// Generates the vendored modules for pi-vision-router straight from DVR source
// text (no manual transcription), then audits for leftover DSH references.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Layout: <root>/pi-vision-router/tools/make-vendor.mjs, sibling of the DVR clone.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.dirname(HERE)
const ROOT = path.dirname(PKG)
const SRC = process.env.DVR_SRC ?? path.join(ROOT, 'dsh-vision-router', 'src', 'lib', 'core-primitives.js')
const CAP = process.env.DVR_CAPTURE ?? path.join(ROOT, 'dsh-vision-router', 'src', 'lib', 'windows-desktop-capture.js')
const OUT_DIR = path.join(PKG, 'extensions', 'vendor')
const src = await readFile(SRC, 'utf8')

const fns = [
  'visionDetectInstruction',
  'describeStructuredInstruction',
  'visionDescribePrompt',
  'normalizeDetectResult',
  'normalizeDescribeResult',
  'quantizeColors',
  'computePixelDiff',
  'renderDiffHeatmap',
  'boxToSvg',
  'boxesToSvg',
  'floodFillBackground',
  'bitmapOfGray',
  'longOcrWindows',
  'parseBox',
  'extractJson',
  'artifactStemOf',
  'basenameOf',
  'mediaTypeOf',
  'sniffMediaType',
  'isAttachmentIdInput',
  'parseTesseractTsv',
  'assessTesseractOcr',
  'selectTesseractOcrCandidate',
  'resolveVisionOcrEngine',
]

// sharp-backed helpers re-expressed against plain sharp: Pi has no DSH resource
// governor, so only the budget wrapper is dropped (algorithm kept identical).
const sharpFns = {
  annotateBoxBuffer: `export async function annotateBoxBuffer(bytes, box) {
  const sharp = await loadSharp()
  const meta = await sharp(bytes, { failOn: 'none' }).metadata()
  const width = meta.width ?? box.x2
  const height = meta.height ?? box.y2
  const preview = scaledDimensions(width, height, SHARP_MAX_PIXELS)
  const displayBox = preview.scale === 1 ? box : scaleBox(box, width, height, preview.width, preview.height)
  let image = sharp(bytes, { failOn: 'none' })
  if (preview.scale !== 1) image = image.resize(preview.width, preview.height, { fit: 'fill' })
  return image
    .composite([{ input: boxToSvg(displayBox, preview.width, preview.height), top: 0, left: 0 }])
    .png()
    .toBuffer()
}`,
  annotateBoxesBuffer: `export async function annotateBoxesBuffer(bytes, boxes) {
  const sharp = await loadSharp()
  const meta = await sharp(bytes, { failOn: 'none' }).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (width <= 0 || height <= 0 || boxes.length === 0) return bytes
  const preview = scaledDimensions(width, height, SHARP_MAX_PIXELS)
  const displayBoxes = preview.scale === 1
    ? boxes
    : boxes.map((box) => scaleBox(box, width, height, preview.width, preview.height))
  let image = sharp(bytes, { failOn: 'none' })
  if (preview.scale !== 1) image = image.resize(preview.width, preview.height, { fit: 'fill' })
  return image
    .composite([{ input: boxesToSvg(displayBoxes, preview.width, preview.height), top: 0, left: 0 }])
    .png()
    .toBuffer()
}`,
  downscaleImage: `/**
 * Bound an image to a semantic-processing pixel budget. Metadata probing is
 * fail-open only until the source is proven oversized; once oversize is proven,
 * preprocessing is a safety boundary and MUST fail closed (upstream semantics).
 */
export async function downscaleImage(bytes, maxPixels, options = {}) {
  if (!bytes || bytes.length === 0) return bytes
  const sharp = await loadSharp()
  let meta
  try {
    meta = await sharp(bytes, { failOn: 'none' }).metadata()
  } catch {
    return bytes
  }
  if (!meta.width || !meta.height) return bytes
  if (meta.width * meta.height <= maxPixels) return bytes
  const target = scaledDimensions(meta.width, meta.height, maxPixels)
  try {
    const resized = await sharp(bytes, { failOn: 'none' })
      .resize({ width: target.width, height: target.height, fit: 'inside' })
      .toBuffer()
    if (!resized || resized.length === 0) throw new Error('image resize produced an empty buffer')
    return resized
  } catch (cause) {
    if (cause && cause.code === 'VISION_IMAGE_PREPROCESS_FAILED') throw cause
    const error = new Error('VISION_IMAGE_PREPROCESS_FAILED: oversized image could not be reduced to the safe execution budget')
    error.code = 'VISION_IMAGE_PREPROCESS_FAILED'
    error.cause = cause
    throw error
  }
}`,
  cropRegion: `export async function cropRegion(bytes, box, maxPixels) {
  const sharp = await loadSharp()
  const sourceWidth = box.x2 - box.x1
  const sourceHeight = box.y2 - box.y1
  const preview = scaledDimensions(sourceWidth, sourceHeight, maxPixels)
  let pipeline = sharp(bytes, { failOn: 'none' }).extract({
    left: box.x1,
    top: box.y1,
    width: sourceWidth,
    height: sourceHeight,
  })
  if (preview.scale !== 1) pipeline = pipeline.resize(preview.width, preview.height, { fit: 'fill' })
  const buffer = await pipeline.png().toBuffer()
  return { buffer, ...preview }
}`,
  rgbaOf: `/** Decode any supported image into raw RGBA plus its dimensions. */
export async function rgbaOf(bytes) {
  const sharp = await loadSharp()
  const image = sharp(bytes, { failOn: 'none' })
  const info = await image.metadata()
  const data = await image.ensureAlpha().raw().toBuffer()
  return { data, width: info.width ?? 0, height: info.height ?? 0 }
}`,
  imageDims: `export async function imageDims(bytes) {
  const sharp = await loadSharp()
  const meta = await sharp(bytes, { failOn: 'none' }).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}`,
}

// MIT requires the upstream copyright notice to travel with the copied code, so
// every generated file carries it ahead of the mechanical banner.
const ATTRIBUTION = `// Vendored from dsh-vision-router v3.0.3 (https://github.com/ysr666/dsh-vision-router)
// Copyright (c) 2026 dsh-vision-router contributors -- MIT License.
// See LICENSE and NOTICE in this package for the full notice.
`

const PRELUDE = `// GENERATED by tools/make-vendor.mjs -- vendored from dsh-vision-router v3.0.3.
// Pure prompt/pixel/OCR helpers sliced verbatim from src/lib/core-primitives.js.
// sharp-backed helpers are re-expressed against plain sharp: Pi has no DSH
// resource governor, so only the budget wrapper is dropped.
${ATTRIBUTION}import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
export const execFileAsync = promisify(execFile)
const MAX_EXTRACT_JSON_CHARS = 1024 * 1024
const TESSERACT_OCR_PSMS = Object.freeze([6, 3, 11])
const TESSERACT_REVIEW_THRESHOLD = 70
const TESSERACT_CANDIDATE_MARGIN = 5
const TESSERACT_CONFUSABLE_RUN = /[0O1IlL]{3,}/
export const SHARP_MAX_PIXELS = 4_000_000

let sharpLoader
/** sharp is an optional dependency: pixel tools degrade without it. */
export async function loadSharp() {
  if (!sharpLoader) {
    sharpLoader = import('sharp').then((mod) => mod.default ?? mod).catch((error) => {
      throw new Error('sharp is unavailable (pixel tools disabled): ' + (error && error.message ? error.message : String(error)))
    })
  }
  return sharpLoader
}

/** Fit width*height inside maxPixels preserving aspect ratio. */
export function scaledDimensions(width, height, maxPixels) {
  const pixels = width * height
  if (!(pixels > maxPixels)) return { width, height, scale: 1 }
  const scale = Math.sqrt(maxPixels / pixels)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

function scaleBox(box, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  return {
    x1: Math.round((box.x1 * targetWidth) / sourceWidth),
    y1: Math.round((box.y1 * targetHeight) / sourceHeight),
    x2: Math.round((box.x2 * targetWidth) / sourceWidth),
    y2: Math.round((box.y2 * targetHeight) / sourceHeight),
  }
}

function isVisionAbort(error, signal) {
  return Boolean(signal?.aborted) || Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))
}

function visionAbortReason(signal, fallback = 'vision operation aborted') {
  const reason = signal && typeof signal.reason === 'string' && signal.reason !== '' ? signal.reason : fallback
  const error = new Error(reason)
  error.name = 'AbortError'
  return error
}

function throwIfVisionAborted(signal, fallback) {
  if (signal?.aborted) throw visionAbortReason(signal, fallback)
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle]
}

/** Bounded deadline shared by one vision task and its fallbacks. */
export function createDeadline(timeoutMs) {
  const started = Date.now()
  const budget = Math.max(1, Math.floor(Number(timeoutMs) || 1))
  return {
    remaining: () => Math.max(0, budget - (Date.now() - started)),
    expired: () => Date.now() - started >= budget,
    elapsed: () => Date.now() - started,
    budget,
  }
}

export async function ocrWithTesseract(bytes, timeoutMs = 60000, options = {}) {
  const exec = typeof options.exec === 'function' ? options.exec : execFileAsync
  const signal = options.signal
  throwIfVisionAborted(signal, 'tesseract OCR aborted')
  const { stdout } = await exec('tesseract', ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '6'], {
    timeout: Math.min(timeoutMs, 60000),
    maxBuffer: 32 * 1024 * 1024,
    input: bytes,
    ...(signal === undefined ? {} : { signal }),
  })
  throwIfVisionAborted(signal, 'tesseract OCR aborted')
  return String(stdout ?? '')
}

export async function ocrWithTesseractAdaptive(bytes, timeoutMs = 12000, options = {}) {
  const exec = typeof options.exec === 'function' ? options.exec : execFileAsync
  const signal = options.signal
  const requestedBudget = Number(timeoutMs)
  const budgetMs = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.min(60000, requestedBudget) : 12000
  const started = Date.now()
  const attemptedPsms = []
  const remaining = () => Math.max(1, budgetMs - (Date.now() - started))
  const run = async (psm) => {
    throwIfVisionAborted(signal, 'adaptive tesseract OCR aborted')
    attemptedPsms.push(psm)
    const common = ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', String(psm)]
    const execOptions = () => ({
      timeout: remaining(),
      maxBuffer: 32 * 1024 * 1024,
      input: bytes,
      ...(signal === undefined ? {} : { signal }),
    })
    const { stdout: plain } = await exec('tesseract', common, execOptions())
    throwIfVisionAborted(signal, 'adaptive tesseract OCR aborted')
    const text = String(plain ?? '').trim()
    if (text === '') return assessTesseractOcr('', '', psm)
    try {
      const { stdout: tsv } = await exec('tesseract', [...common, 'tsv'], execOptions())
      throwIfVisionAborted(signal, 'adaptive tesseract OCR aborted')
      return assessTesseractOcr(text, String(tsv ?? ''), psm)
    } catch (error) {
      if (isVisionAbort(error, signal)) throw error
      return { psm, text, words: 0, quality: 0, riskyTokens: [], uncertain: true }
    }
  }

  const candidates = [await run(TESSERACT_OCR_PSMS[0])]
  if (candidates[0].text !== '' && !candidates[0].uncertain) return { ...candidates[0], attemptedPsms }
  for (const psm of TESSERACT_OCR_PSMS.slice(1)) {
    if (Date.now() - started >= budgetMs) break
    try {
      candidates.push(await run(psm))
    } catch (error) {
      if (isVisionAbort(error, signal)) throw error
      // Keep the first successful local pass when an optional review pass fails.
    }
  }
  const selected = selectTesseractOcrCandidate(candidates) ?? candidates[0]
  return { ...selected, attemptedPsms }
}

/** potrace is CPU-bound in long synchronous chunks: run it in a worker. */
export function posterizeSvg(bytes, steps = 4, fillStrategy = 'dominant', timeoutMs = 60000, options = {}) {
  const signal = options?.signal
  return new Promise((resolve, reject) => {
    let settled = false
    let worker
    let timer
    let abortListener
    const finish = (error, svg) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (signal && abortListener) signal.removeEventListener?.('abort', abortListener)
      void worker?.terminate()
      if (error) reject(error)
      else resolve(svg)
    }
    abortListener = () => finish(visionAbortReason(signal, 'potrace aborted'))
    if (signal?.aborted) {
      finish(visionAbortReason(signal, 'potrace aborted'))
      return
    }
    signal?.addEventListener?.('abort', abortListener, { once: true })
    timer = setTimeout(() => {
      finish(new Error('potrace timed out -- crop it to the target region first'))
    }, timeoutMs)
    try {
      const potraceUrl = pathToFileURL(require.resolve('potrace')).href
      const source = \`
        import('node:worker_threads').then(({ parentPort, workerData }) => {
          import(workerData.potraceUrl).then((mod) => {
            const potrace = mod.default ?? mod
            potrace.posterize(Buffer.from(workerData.bytes), {
              steps: workerData.steps,
              fillStrategy: workerData.fillStrategy,
            }, (error, svg) => {
              parentPort.postMessage(error ? { error: String((error && error.message) || error) } : { svg })
            })
          }).catch((error) => {
            parentPort.postMessage({ error: String((error && error.message) || error) })
          })
        })
      \`
      worker = new Worker(source, { eval: true, workerData: { potraceUrl, bytes, steps, fillStrategy } })
      worker.once('message', (message) => {
        if (message && message.error) finish(new Error(message.error))
        else finish(undefined, message && message.svg)
      })
      worker.once('error', (error) => finish(error))
      worker.once('exit', (code) => {
        if (code !== 0 && !settled) finish(new Error('potrace worker exited with code ' + code))
      })
    } catch (error) {
      finish(error)
    }
  })
}

let tesseractProbe
/** True when a tesseract binary is reachable on PATH. Probed once per process. */
export function hasTesseract() {
  if (tesseractProbe === undefined) {
    try {
      tesseractProbe = spawnSync('tesseract', ['--version'], { timeout: 8000 }).status === 0
    } catch {
      tesseractProbe = false
    }
  }
  return tesseractProbe
}
`

const TOP_LEVEL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|import|export\s+\{|export\s+\*)/

function sliceFn(name) {
  const lines = src.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^(?:export )?(?:async )?function ${name}\\(`).test(line))
  if (start === -1) throw new Error(`NOT FOUND: ${name}`)
  // Keep the doc comment immediately above the declaration.
  let from = start - 1
  while (from >= 0 && (/^\s*\*|^\s*\/\*|^\s*\/\/$/.test(lines[from]) || /^\s*\/\*.*\*\/\s*$/.test(lines[from]))) from--
  from++
  let end = start + 1
  while (end < lines.length && !TOP_LEVEL.test(lines[end])) end++
  end--
  while (end > start && lines[end].trim() === '') end--
  return lines.slice(from, end + 1).join('\n') + '\n'
}

function sliceConst(name) {
  // Line-based: the table ends at the first `}` that closes the line, so no
  // brace scanner can be thrown off by regex literals or comments inside it.
  const lines = src.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`export const ${name} = `))
  if (start === -1) throw new Error(`CONST NOT FOUND: ${name}`)
  let end = start
  while (end < lines.length && !/^\}/.test(lines[end])) end++
  if (end >= lines.length) throw new Error(`CONST UNTERMINATED: ${name}`)
  return lines.slice(start, end + 1).join('\n') + '\n'
}

await mkdir(OUT_DIR, { recursive: true })

const parts = [PRELUDE, sliceConst('IMAGE_EXTENSIONS')]
for (const name of fns) parts.push(sliceFn(name))
parts.push(Object.values(sharpFns).join('\n'))
const code = parts.join('\n')

const banned = ['defaultImageResourceGovernor', 'estimateImageOperationBytes', 'isOffloadedImageBlock', 'offloadedImagePlaceholder', 'fetchWithOpenAICompatibility', 'directSessionAffinityHeaders', 'ctx.logger', '@deepseek-ai']
const found = banned.filter((id) => code.includes(id))
await writeFile(`${OUT_DIR}/primitives.js`, code, 'utf8')

// windows-desktop-capture.js is already self-contained (node builtins only)
const cap = await readFile(CAP, 'utf8')
await writeFile(`${OUT_DIR}/capture-windows.js`, `${ATTRIBUTION}${cap}`, 'utf8')

// Self-contained upstream modules are copied whole with the MIT notice ahead of
// them: hand-copied files drift silently and carry no attribution, so they are
// generator output too.
const VERBATIM = [
  'vision-resilience.js',
  'vision-breaker-observer.js',
  'http-compat.js',
  'string-normalization.js',
  'abort-signal-compat.js',
]
const LIB_DIR = path.dirname(SRC)
for (const name of VERBATIM) {
  const text = await readFile(path.join(LIB_DIR, name), 'utf8')
  await writeFile(path.join(OUT_DIR, name), `${ATTRIBUTION}${text}`, 'utf8')
  console.log(`${name} ${text.length} bytes (verbatim + notice)`)
}

console.log(`primitives.js ${code.length} bytes; DSH leftovers: ${found.join(', ') || 'none'}`)
console.log(`capture-windows.js ${cap.length} bytes (verbatim copy)`)
