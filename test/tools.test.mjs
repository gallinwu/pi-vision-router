// Tool-layer smoke test: exercise vision_describe/vision_ocr through buildTools
// with a stub ctx, so a broken tool schema or image resolver fails here rather
// than mid-agent-turn.
import { buildTools } from '../extensions/tools.js'
import { createVisionEngine } from '../extensions/engine.js'
import * as P from '../extensions/vendor/primitives.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const artifactsDir = mkdtempSync(path.join(tmpdir(), 'pvr-tools-'))
const settings = { downscale: true, downscaleMaxPixels: P.SHARP_MAX_PIXELS, taskTimeoutMs: 120000 }
const engine = createVisionEngine({ settings: () => settings })

const ctx = {
  settings,
  engine,
  cwd: path.resolve('test-fixtures'),
  artifactsDir,
  resolveCache: () => undefined,
  scope: () => 'test:1',
  createDeadline: () => P.createDeadline(120000),
}

const tools = buildTools(ctx)
console.log('tools:', tools.map((t) => t.name).join(', '))
for (const tool of tools) {
  if (typeof tool.execute !== 'function') throw new Error(`${tool.name} has no execute`)
  if (tool.parameters === undefined) throw new Error(`${tool.name} has no parameters schema`)
}

const describe = tools.find((t) => t.name === 'vision_describe')
const result = await describe.execute('t1', { paths: ['probe.png'], question: 'What text is in this image?' }, undefined, undefined, undefined)
const text = result?.content?.find?.((c) => c.type === 'text')?.text ?? ''
console.log('vision_describe ->', text.slice(0, 200))
if (!text.trim()) throw new Error('vision_describe returned no text')
console.log('TOOL LAYER OK')
