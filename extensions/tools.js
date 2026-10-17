// Tool implementations for pi-vision-router. Each tool follows the DVR contract:
// machine-readable JSON results, ok:false + code on backend failure, and a
// never-retry-this-turn policy carried by VISION_DO_NOT_RETRY_ADVICE.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import * as P from './vendor/primitives.js'

const FAILURE_HINT =
  'FAILURE SEMANTICS: if the result is JSON with ok:false, the vision backends are unavailable this turn. ' +
  'Do NOT reword the question and retry -- rephrasing cannot fix auth, rate-limit or outage failures. ' +
  'Answer from what you already have and tell the user vision is temporarily unavailable.'

const imageParam = {
  image: Type.String({
    description: 'Local image path (png/jpeg/webp/gif) or a stored image id (img:<name>) from vision_materialize / an earlier input turn',
  }),
}

async function resolveImage(image, ctx) {
  if (typeof image !== 'string' || image.trim() === '') throw new Error('image is required')
  // Cached turn images (base64 handed to the extension this turn) never touch
  // the filesystem, so an oversized paste cannot fail on disk quota.
  if (ctx.resolveCache?.(image)) {
    const hit = ctx.resolveCache(image)
    return { bytes: hit.bytes, mediaType: hit.mediaType }
  }
  let bytes
  if (image.startsWith('img:')) {
    bytes = await readFile(path.join(ctx.artifactsDir, image.slice(4).replace(/[^\w.-]/g, '_')))
  } else {
    bytes = await readFile(path.isAbsolute(image) ? image : path.resolve(ctx.cwd, image))
  }
  if (!bytes || bytes.length === 0) throw new Error(`image is empty: ${image}`)
  let mediaType = P.mediaTypeOf(image) || P.sniffMediaType(bytes) || 'image/png'
  if (ctx.settings.downscale !== false) {
    const resized = await P.downscaleImage(bytes, ctx.settings.downscaleMaxPixels ?? P.SHARP_MAX_PIXELS)
    if (resized !== bytes) mediaType = P.sniffMediaType(resized) || mediaType
    bytes = resized
  }
  return { bytes, mediaType }
}

async function saveArtifact(ctx, name, buffer) {
  await mkdir(ctx.artifactsDir, { recursive: true })
  const target = path.join(ctx.artifactsDir, name.replace(/[^\w.@-]/g, '_'))
  await writeFile(target, buffer)
  return target
}

function failureResult(failure) {
  return {
    content: [{ type: 'text', text: JSON.stringify(failure) }],
    details: { ok: false, code: failure.code },
    structuredContent: failure,
  }
}

function okResult(payload, text) {
  const body = text ?? JSON.stringify(payload)
  return { content: [{ type: 'text', text: body }], details: payload, structuredContent: payload }
}

/** A per-call view of the shared ctx with the live tool-run cwd. */
function forRun(ctx, runCtx) {
  return {
    settings: ctx.settings,
    engine: ctx.engine,
    artifactsDir: ctx.artifactsDir,
    resolveCache: ctx.resolveCache,
    scope: ctx.scope,
    createDeadline: ctx.createDeadline,
    cwd: runCtx?.cwd ?? ctx.cwd,
  }
}

export function buildTools(ctx) {
  const tools = []

  tools.push(defineTool({
    name: 'vision_describe',
    label: 'vision describe',
    description:
      'Look at images with the configured vision chain and answer a focused question. This is the bridge that ' +
      'gives a text-only Pi model eyes: it reads local image files (and, for compatibility, an image path per ' +
      'entry) and returns the model answer. Supports comparing multiple images (mock vs implementation). ' +
      `1-4 images. Set json:true to require one JSON object. ${FAILURE_HINT}`,
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { description: 'Image file paths or img:<name> ids, 1-4 entries' }),
      question: Type.String({ description: 'The question for the vision model' }),
      json: Type.Optional(Type.Boolean({ description: 'Require a single valid JSON object as the answer' })),
    }),
    async execute(_id, params, signal, _onUpdate, runCtx) {
      if (ctx.settings.tool === false) throw new Error('vision_describe: the vision tool is disabled in settings')
      const images = []
      const list = Array.isArray(params.paths) ? params.paths : []
      if (list.length === 0 || list.length > 4) throw new Error('vision_describe: provide 1-4 images')
      for (const item of list) {
        const { bytes, mediaType } = await resolveImage(item, forRun(ctx, runCtx))
        images.push({ bytes, mediaType })
      }
      const answer = await ctx.engine.ask(images, P.visionDescribePrompt(params.question, params.json === true), {
        scope: ctx.scope(runCtx),
        signal: signal ?? runCtx?.signal,
        deadline: ctx.createDeadline(),
      })
      if (answer.ok === false) return failureResult(answer)
      if (params.json === true) {
        const parsed = P.extractJson(answer.text)
        if (parsed && typeof parsed === 'object') {
          const normalized = P.normalizeDescribeResult(parsed) ?? parsed
          return okResult({ ok: true, provider: answer.provider, result: normalized })
        }
        return okResult({ ok: true, provider: answer.provider, jsonParseFailed: true, text: answer.text })
      }
      return okResult({ ok: true, provider: answer.provider, text: answer.text }, answer.text)
    },
  }))

  tools.push(defineTool({
    name: 'vision_ground',
    label: 'vision ground',
    description:
      'Locate a target in an image and return its ORIGINAL-pixel bounding box (x1/y1/x2/y2), plus an annotated ' +
      `PNG artifact path. ${FAILURE_HINT}`,
    parameters: Type.Object({ ...imageParam, target: Type.String({ description: 'What to locate, e.g. "the send button"' }), annotate: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _onUpdate, runCtx) {
      const instruction = (width, height) =>
        `Target to locate: "${String(params.target).slice(0, 500)}". The image is ${width}x${height} pixels. ` +
        'Return ONE JSON object with integer fields {"x1":...,"y1":...,"x2":...,"y2":...} -- the tight bounding ' +
        `box of that target in ORIGINAL image pixels (0 <= x1 < x2 <= ${width}, 0 <= y1 < y2 <= ${height}). Output only the JSON object.`
      const { bytes, mediaType } = await resolveImage(params.image, forRun(ctx, runCtx))
      const dims = await P.imageDims(bytes)
      if (dims.width <= 0 || dims.height <= 0) throw new Error('vision_ground: could not read image dimensions')
      const first = await ctx.engine.ask([{ bytes, mediaType }], instruction(dims.width, dims.height), {
        scope: ctx.scope(runCtx), signal, deadline: ctx.createDeadline(),
      })
      if (first.ok === false) return failureResult(first)
      const parsed = P.extractJson(first.text)
      let box = parsed !== undefined ? P.parseBox(parsed) : undefined
      if (box === undefined) throw new Error(`vision_ground: no valid box. Raw: ${first.text.slice(0, 400)}`)
      box = {
        x1: Math.max(0, Math.min(box.x1, dims.width - 1)),
        y1: Math.max(0, Math.min(box.y1, dims.height - 1)),
        x2: Math.max(1, Math.min(box.x2, dims.width)),
        y2: Math.max(1, Math.min(box.y2, dims.height)),
      }
      if (box.x2 - box.x1 < 2 || box.y2 - box.y1 < 2) {
        const retry = await ctx.engine.ask([{ bytes, mediaType }], `Your previous box ${JSON.stringify(box)} was a degenerate sliver. ` + instruction(dims.width, dims.height), {
          scope: ctx.scope(runCtx), signal, deadline: ctx.createDeadline(),
        })
        if (retry.ok === false) return failureResult(retry)
        const rb = P.parseBox(P.extractJson(retry.text) ?? {})
        if (rb === undefined) throw new Error(`vision_ground: only degenerate boxes returned. Raw: ${retry.text.slice(0, 400)}`)
        box = rb
      }
      const result = { ...box, width: dims.width, height: dims.height }
      if (params.annotate !== false) {
        result.annotatedPath = await saveArtifact(ctx, `${P.artifactStemOf(params.image, 'ground')}.png`, await P.annotateBoxBuffer(bytes, box))
      }
      return okResult(result)
    },
  }))

  tools.push(defineTool({
    name: 'vision_detect',
    label: 'vision detect',
    description:
      'Find every element of a kind (buttons, inputs, links, icons...) and return a numbered inventory with ' +
      `ORIGINAL-pixel boxes, optionally annotated. Reference "element #3" in later calls. ${FAILURE_HINT}`,
    parameters: Type.Object({ ...imageParam, target: Type.Optional(Type.String({ description: 'Kind of elements to list (default: interactive elements)' })), annotate: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _onUpdate, runCtx) {
      const { bytes, mediaType } = await resolveImage(params.image, forRun(ctx, runCtx))
      const dims = await P.imageDims(bytes)
      const target = typeof params.target === 'string' && params.target.trim() !== '' ? params.target : 'interactive elements'
      const instruction = P.visionDetectInstruction(target, dims.width, dims.height)
      let answer = await ctx.engine.ask([{ bytes, mediaType }], instruction, { scope: ctx.scope(runCtx), signal, deadline: ctx.createDeadline() })
      if (answer.ok === false) return failureResult(answer)
      let result = P.normalizeDetectResult(P.extractJson(answer.text), dims.width, dims.height)
      if (result === undefined) {
        answer = await ctx.engine.ask([{ bytes, mediaType }], instruction + '\nYour previous answer was invalid or did not satisfy the exact elements/label/box schema. Respond with ONLY the complete JSON object.', {
          scope: ctx.scope(runCtx), signal, deadline: ctx.createDeadline(),
        })
        if (answer.ok === false) return failureResult(answer)
        result = P.normalizeDetectResult(P.extractJson(answer.text), dims.width, dims.height)
      }
      if (result === undefined) throw new Error(`vision_detect: no valid inventory. Raw: ${answer.text.slice(0, 400)}`)
      if (params.annotate !== false && result.elements.length > 0) {
        result.annotatedPath = await saveArtifact(ctx, `${P.artifactStemOf(params.image, 'detect')}.png`, await P.annotateBoxesBuffer(bytes, result.elements.map((e) => e.box)))
      }
      return okResult(result)
    },
  }))

  tools.push(defineTool({
    name: 'vision_crop',
    label: 'vision crop',
    description: 'Crop a pixel region (x1,y1,x2,y2 in ORIGINAL pixels) and write a PNG artifact for a closer look.',
    parameters: Type.Object({ ...imageParam, region: Type.String({ description: 'Pixel box "x1,y1,x2,y2"' }) }),
    async execute(_id, params, _signal, _onUpdate, runCtx) {
      const { bytes } = await resolveImage(params.image, forRun(ctx, runCtx))
      const dims = await P.imageDims(bytes)
      const box = P.parseBox(params.region)
      if (box === undefined) throw new Error(`vision_crop: invalid region "${params.region}"`)
      if (box.x2 > dims.width || box.y2 > dims.height) throw new Error(`vision_crop: region exceeds image bounds (${dims.width}x${dims.height})`)
      const crop = await P.cropRegion(bytes, box, ctx.settings.cropMaxPixels ?? P.SHARP_MAX_PIXELS)
      const name = `${P.artifactStemOf(params.image, `crop-${box.x1}-${box.y1}-${box.x2}-${box.y2}`)}.png`
      const target = await saveArtifact(ctx, name, crop.buffer)
      return okResult({
        path: target,
        width: crop.width,
        height: crop.height,
        bytes: crop.buffer.length,
        ...(crop.scale !== 1 ? { preview: true, sourceRegion: box, scale: crop.scale, advice: 'bounded preview of a large crop; crop a smaller region for tiny details' } : {}),
      })
    },
  }))

  tools.push(defineTool({
    name: 'vision_ocr',
    label: 'vision ocr',
    description:
      'Transcribe TEXT from an image. engine auto = local tesseract (chi_sim+eng) first, then vision fallback. ' +
      'Reads letters only -- it does NOT recognize people/objects/scenes (use vision_describe for that). ' +
      'If uncertain:true, cross-check ambiguous glyphs (1/l, 0/O) when another backend exists. ' +
      `Prefer vision_describe unless exact verbatim text is required. ${FAILURE_HINT}`,
    parameters: Type.Object({ ...imageParam, engine: Type.Optional(Type.String({ description: 'auto | tesseract | vision' })) }),
    async execute(_id, params, signal, _onUpdate, runCtx) {
      const engine = P.resolveVisionOcrEngine(params.engine, ctx.settings.ocrEngine ?? 'auto')
      const { bytes, mediaType } = await resolveImage(params.image, forRun(ctx, runCtx))
      const deadline = ctx.createDeadline()
      if (engine !== 'vision') {
        try {
          const local = await P.ocrWithTesseractAdaptive(bytes, Math.min(12000, deadline.remaining()), { signal })
          if (local.text.trim() !== '') {
            return okResult({ engine: 'tesseract', text: local.text.trim(), uncertain: local.uncertain === true, ...(local.uncertain ? { review: { psm: local.psm, quality: Number(local.quality.toFixed(2)), riskyTokens: local.riskyTokens } } : {}) })
          }
          if (engine === 'tesseract') return okResult({ engine: 'tesseract', text: '', uncertain: true })
        } catch (error) {
          if (engine === 'tesseract') throw new Error(`vision_ocr: local tesseract failed (${error.message})`)
        }
      }
      if (deadline.expired()) {
        return failureResult({ ok: false, code: 'VISION_TIMEOUT', retryable: false, reason: 'vision_ocr: OCR budget exhausted before the vision fallback ran' })
      }
      const answer = await ctx.engine.ask([{ bytes, mediaType }], '请原样转述图中的所有文字，保持阅读顺序（从上到下、从左到右）与段落结构，不要添加解释。只输出文字本身。', {
        scope: ctx.scope(runCtx), signal, deadline,
      })
      if (answer.ok === false) return failureResult({ ...answer, text: '' })
      return okResult({ engine: 'vision', text: answer.text })
    },
  }))

  tools.push(defineTool({
    name: 'vision_pixel_diff',
    label: 'vision pixel diff',
    description:
      'Compare two images pixel-by-pixel and return differing count/ratio plus 8x8 hot cells (original-pixel ' +
      'boxes), optionally writing a red-on-gray heatmap PNG. Use it to VERIFY a visual change actually landed.',
    parameters: Type.Object({ before: Type.String({ description: 'First image path (reference)' }), after: Type.String({ description: 'Second image path (implementation)' }), threshold: Type.Optional(Type.Number({ description: 'Per-channel tolerance, default 16' })), heatmap: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _onUpdate, runCtx) {
      const local = forRun(ctx, runCtx)
      const a = await resolveImage(params.before, local)
      const b = await resolveImage(params.after, local)
      const A = await P.rgbaOf(a.bytes)
      const B = await P.rgbaOf(b.bytes)
      if (A.width !== B.width || A.height !== B.height) {
        // Align to the smaller frame so a resize does not read as a global diff.
        const width = Math.min(A.width, B.width)
        const height = Math.min(A.height, B.height)
        A.data = (await P.rgbaOf(await (await import('sharp')).default(a.bytes).resize(width, height, { fit: 'fill' }).png().toBuffer())).data
        B.data = (await P.rgbaOf(await (await import('sharp')).default(b.bytes).resize(width, height, { fit: 'fill' }).png().toBuffer())).data
        A.width = B.width = width
        A.height = B.height = height
      }
      const diff = P.computePixelDiff(A.data, B.data, params.threshold ?? 16, A.width, A.height)
      const out = {
        identical: diff.differing === 0,
        differing: diff.differing,
        total: diff.total,
        ratio: Number(diff.ratio.toFixed(6)),
        size: { width: A.width, height: A.height },
        hotCells: diff.cells.slice(0, 12),
      }
      if (params.heatmap !== false) {
        const heat = P.renderDiffHeatmap(A.data, diff.mask, A.width, A.height)
        const sharp = (await import('sharp')).default
        out.heatmapPath = await saveArtifact(ctx, `${P.artifactStemOf(params.after, 'pixeldiff')}.png`, await sharp(Buffer.from(heat), { raw: { width: A.width, height: A.height, channels: 4 } }).png().toBuffer())
      }
      return okResult(out)
    },
  }))

  tools.push(defineTool({
    name: 'vision_colors',
    label: 'vision colors',
    description: 'Return the dominant palette of an image (or a pixel region) as hex with coverage share. Optionally sample exact pixels at coordinates.',
    parameters: Type.Object({ ...imageParam, top: Type.Optional(Type.Number({ description: 'How many colors, default 8' })), points: Type.Optional(Type.Array(Type.String({ description: '"x,y" coordinates to sample exactly' }))) }),
    async execute(_id, params, _signal, _onUpdate, runCtx) {
      const { bytes } = await resolveImage(params.image, forRun(ctx, runCtx))
      const rgba = await P.rgbaOf(bytes)
      const palette = P.quantizeColors(rgba.data, params.top ?? 8)
      let samples
      if (Array.isArray(params.points)) {
        samples = params.points.map((point) => {
          const [x, y] = String(point).split(',').map((n) => Number(n.trim()))
          if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= rgba.width || y >= rgba.height) {
            return { point, error: 'out of bounds' }
          }
          const o = (y * rgba.width + x) * 4
          const hex = '#' + [rgba.data[o], rgba.data[o + 1], rgba.data[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
          return { point: `${x},${y}`, hex, alpha: rgba.data[o + 3] }
        })
      }
      return okResult({ width: rgba.width, height: rgba.height, palette, ...(samples ? { samples } : {}) })
    },
  }))

  tools.push(defineTool({
    name: 'vision_materialize',
    label: 'vision materialize',
    description: 'Save a base64 image (e.g. one an attachment/tool result produced) into the artifacts dir and return its path plus img:<name> id for other vision tools.',
    parameters: Type.Object({
      data: Type.String({ description: 'Raw base64 image data (no data: prefix)' }),
      name: Type.Optional(Type.String({ description: 'Target file name' })),
      mediaType: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const bytes = Buffer.from(String(params.data).replace(/^data:[^;]+;base64,/, ''), 'base64')
      if (bytes.length === 0) throw new Error('vision_materialize: empty base64 payload')
      const name = params.name || `img-${Date.now().toString(36)}.png`
      const target = await saveArtifact(ctx, name, bytes)
      return okResult({ path: target, id: `img:${name}`, bytes: bytes.length })
    },
  }))

  tools.push(defineTool({
    name: 'vision_trace',
    label: 'vision trace',
    description: 'Vectorize a raster image (icon/logo/line art) into SVG with potrace and write it as an artifact. Large images should be cropped first.',
    parameters: Type.Object({ ...imageParam, steps: Type.Optional(Type.Number({ description: 'posterize steps 2-8, default 4' })), color: Type.Optional(Type.Boolean({ description: 'Also emit a color-quantized pass description (default false, grayscale trace)' })) }),
    async execute(_id, params, signal, _onUpdate, runCtx) {
      const { bytes } = await resolveImage(params.image, forRun(ctx, runCtx))
      const maxPixels = ctx.settings.traceMaxPixels ?? 1_000_000
      const prepared = await P.downscaleImage(bytes, maxPixels)
      const bmp = await (await import('sharp')).default(prepared).toFormat('bmp').toBuffer()
      const svg = await P.posterizeSvg(bmp, params.steps ?? 4, params.color === true ? 'dominant' : 'minority', ctx.settings.traceTimeoutMs ?? 60000, { signal })
      const target = await saveArtifact(ctx, `${P.artifactStemOf(params.image, 'trace')}.svg`, Buffer.from(String(svg)))
      return okResult({ path: target, bytes: Buffer.byteLength(svg) })
    },
  }))

  tools.push(defineTool({
    name: 'vision_extract_foreground',
    label: 'vision cutout',
    description: 'Remove a near-uniform background (flood fill from the borders) and write a transparent PNG cutout.',
    parameters: Type.Object({ ...imageParam, tolerance: Type.Optional(Type.Number({ description: 'Color distance tolerance, default 40' })) }),
    async execute(_id, params, _signal, _onUpdate, runCtx) {
      const { bytes } = await resolveImage(params.image, forRun(ctx, runCtx))
      const rgba = await P.rgbaOf(bytes)
      const cleared = P.floodFillBackground(rgba.data, rgba.width, rgba.height, params.tolerance ?? 40)
      const sharp = (await import('sharp')).default
      const png = await sharp(Buffer.from(cleared), { raw: { width: rgba.width, height: rgba.height, channels: 4 } }).png().toBuffer()
      const target = await saveArtifact(ctx, `${P.artifactStemOf(params.image, 'cutout')}.png`, png)
      const transparent = Array.from({ length: rgba.width * rgba.height }, (_, i) => cleared[i * 4 + 3] === 0).filter(Boolean).length
      return okResult({ path: target, width: rgba.width, height: rgba.height, removedShare: Number((transparent / (rgba.width * rgba.height)).toFixed(4)) })
    },
  }))

  if (ctx.settings.desktopScreenshot === true) {
    tools.push(defineTool({
      name: 'vision_screenshot',
      label: 'vision screenshot',
      description: 'Capture the desktop (Windows: DPI-aware per-monitor capture) and return the PNG path plus dimensions so other vision tools can inspect it.',
      parameters: Type.Object({ monitor: Type.Optional(Type.String({ description: 'Monitor index (default primary)' })) }),
      async execute(_id, params, signal) {
        const { captureWindowsDesktop } = await import('./vendor/capture-windows.js')
        const name = `desktop-${Date.now().toString(36)}.png`
        const target = path.join(ctx.artifactsDir, name)
        await mkdir(ctx.artifactsDir, { recursive: true })
        if (process.platform === 'win32') {
          await captureWindowsDesktop(target, { timeoutMs: ctx.settings.screenshotTimeoutMs ?? 20000, signal })
        } else {
          throw new Error(`vision_screenshot: desktop capture is only implemented for Windows in this port (platform ${process.platform})`)
        }
        const bytes = await readFile(target)
        const dims = await P.imageDims(bytes)
        return okResult({ path: target, ...dims, bytes: bytes.length })
      },
    }))
  }

  return tools
}

export { FAILURE_HINT }
