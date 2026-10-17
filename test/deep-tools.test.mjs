// Deep-tool smoke: the tools that only mount on image turns still need a real
// run, since a broken sharp path here would only surface mid-agent-turn.
import { buildTools } from '../extensions/tools.js'
import { createVisionEngine } from '../extensions/engine.js'
import * as P from '../extensions/vendor/primitives.js'
import { startMockChain, mockSettings, MOCK_ANSWER } from './mock-chain.mjs'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// vision_ocr falls through to the vision chain when tesseract is absent, so the
// only network-shaped tool here is pointed at the local mock.
const mock = await startMockChain()
const artifactsDir = mkdtempSync(path.join(tmpdir(), 'pvr-deep-'))
const settings = { ...mockSettings(mock), downscale: true, downscaleMaxPixels: P.SHARP_MAX_PIXELS, taskTimeoutMs: 120000 }
const engine = createVisionEngine({ settings: () => settings })
const ctx = {
  settings,
  engine,
  cwd: path.resolve('test-fixtures'),
  artifactsDir,
  resolveCache: () => undefined,
  scope: () => 'test:deep',
  createDeadline: () => P.createDeadline(120000),
}

const tools = buildTools(ctx)
const byName = (name) => tools.find((t) => t.name === name)
const textOf = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

// vision_colors: pure pixel work, no network.
const colors = await byName('vision_colors').execute('c1', { image: 'probe.png', top: 6 }, undefined, undefined, undefined)
console.log('vision_colors ->', textOf(colors).replace(/\s+/g, ' ').slice(0, 160))

// vision_crop: sharp write, must land in artifactsDir.
const crop = await byName('vision_crop').execute('c2', { image: 'probe.png', region: '10,20,70,80' }, undefined, undefined, undefined)
console.log('vision_crop ->', textOf(crop).replace(/\s+/g, ' ').slice(0, 160))

// vision_pixel_diff: same image twice, expect a zero/near-zero diff.
const diff = await byName('vision_pixel_diff').execute('c3', { before: 'probe.png', after: 'probe.png' }, undefined, undefined, undefined)
console.log('vision_pixel_diff ->', textOf(diff).replace(/\s+/g, ' ').slice(0, 160))

// vision_ocr: tesseract is absent, so this must fall through to the vision chain.
const ocr = await byName('vision_ocr').execute('c4', { image: 'probe.png' }, undefined, undefined, undefined)
console.log('vision_ocr ->', textOf(ocr).replace(/\s+/g, ' ').slice(0, 160))

const artifacts = readdirSync(artifactsDir)
console.log('artifacts:', artifacts.length ? artifacts.join(', ') : '(none)')

try {
  if (!artifacts.length) throw new Error('no artifact written by vision_crop')
  if (!textOf(ocr).includes(MOCK_ANSWER)) {
    throw new Error(`vision_ocr did not reach the chain: ${textOf(ocr).slice(0, 200)}`)
  }
} finally {
  await mock.close()
}
console.log('DEEP TOOLS OK')
