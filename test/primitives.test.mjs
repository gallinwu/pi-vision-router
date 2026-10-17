// Smoke test for the vendored primitives: real sharp pixel ops, no network.
import { mkdir } from 'node:fs/promises'
import sharp from 'sharp'

const svg = [
  '<svg width="200" height="120" xmlns="http://www.w3.org/2000/svg">',
  '<rect width="200" height="120" fill="white"/>',
  '<rect x="20" y="30" width="40" height="40" fill="#ff0000"/>',
  '<text x="10" y="100" font-size="18" fill="black">HELLO 12345</text>',
  '</svg>',
].join('')

await mkdir('test-fixtures', { recursive: true })
const png = await sharp(Buffer.from(svg)).png().toBuffer()
const { writeFile } = await import('node:fs/promises')
await writeFile('test-fixtures/probe.png', png)
const big = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#123456' } }).png().toBuffer()
await writeFile('test-fixtures/big.png', big)
console.log('fixtures:', png.length, big.length)

const m = await import('../extensions/vendor/primitives.js')
console.log('exports:', Object.keys(m).length)

const assert = (label, cond, extra = '') => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label} ${extra}`)
  console.log(`ok  ${label} ${extra}`)
}

assert('parseBox string', JSON.stringify(m.parseBox('1,2,30,40')) === '{"x1":1,"y1":2,"x2":30,"y2":40}')
assert('parseBox bad', m.parseBox('a,b,c,d') === undefined)
const sd = m.scaledDimensions(5000, 4000, 4_000_000)
// Upstream rounds each dimension, so the product may exceed the budget by a
// hair; assert the aspect ratio and the scale instead of a strict product cap.
assert('scaledDimensions', Math.abs(sd.width / sd.height - 5 / 4) < 0.001 && sd.scale < 1, JSON.stringify(sd))

const dims = await m.imageDims(png)
assert('imageDims', dims.width === 200 && dims.height === 120, JSON.stringify(dims))
const rgba = await m.rgbaOf(png)
assert('rgbaOf', rgba.data.length === 200 * 120 * 4)
const top = m.quantizeColors(rgba.data, 3)
// Upstream quantizes into 32 bins (step 8), so white floors to #f8f8f8.
assert('quantizeColors', top.length === 3 && top[0].hex === '#f8f8f8' && top[1].hex === '#f80000', JSON.stringify(top.map((c) => c.hex)))

const downscaled = await m.downscaleImage(big, 4_000_000)
const dd = await m.imageDims(downscaled)
// Upstream rounds each dimension, so the product can land a hair over budget.
const budgetSlack = 4_000_000 * 1.01
assert('downscaleImage', dd.width * dd.height <= budgetSlack && downscaled.length < big.length, JSON.stringify(dd))

const crop = await m.cropRegion(png, { x1: 10, y1: 20, x2: 70, y2: 80 }, 4_000_000)
const cd = await m.imageDims(crop.buffer)
assert('cropRegion', cd.width === 60 && cd.height === 60, JSON.stringify(cd))

const box = { x1: 20, y1: 30, x2: 60, y2: 70 }
const ann = await m.annotateBoxBuffer(png, box)
assert('annotateBoxBuffer', ann.length > png.length)
const anns = await m.annotateBoxesBuffer(png, [box, { x1: 100, y1: 10, x2: 150, y2: 50 }])
assert('annotateBoxesBuffer', anns.length > png.length)

const annRgba = await m.rgbaOf(ann)
const diff = m.computePixelDiff(rgba.data, annRgba.data, 16, 200, 120)
assert('computePixelDiff', diff.differing > 0 && diff.cells.length > 0, `differing=${diff.differing} cells=${diff.cells.length}`)
const heat = m.renderDiffHeatmap(rgba.data, diff.mask, 200, 120)
assert('renderDiffHeatmap', heat.length === 200 * 120 * 4)

const fw = m.floodFillBackground(rgba.data, 200, 120, 40)
const cleared = Array.from({ length: 200 * 120 }, (_, i) => fw[i * 4 + 3] === 0).filter(Boolean).length
assert('floodFillBackground', cleared > 200 * 120 * 0.7, `cleared=${cleared}`)

assert('extractJson', JSON.stringify(m.extractJson('noise {"a":1} tail')) === '{"a":1}')
assert('artifactStemOf', m.artifactStemOf('/x/y/shot.png', 'ground').includes('ground'), m.artifactStemOf('/x/y/shot.png', 'ground'))
assert('mediaTypeOf', m.mediaTypeOf('a.PNG') === 'image/png')
assert('sniffMediaType', m.sniffMediaType(png) === 'image/png')
assert('visionDescribePrompt json', m.visionDescribePrompt('what?', true).includes('"summary"'))
assert('normalizeDetectResult ok', JSON.stringify(m.normalizeDetectResult({ elements: [{ label: 'btn', box: { x1: 0, y1: 0, x2: 5, y2: 5 } }] }, 200, 120)).includes('"number":1'))
assert('normalizeDetectResult reject', m.normalizeDetectResult({ elements: [{ label: 'x', box: { x1: 5, y1: 5, x2: 1, y2: 1 } }] }, 200, 120) === undefined)

const windows = m.longOcrWindows(5000, 2000, 200)
assert('longOcrWindows', windows.length === 3 && windows[2].bottom === 5000, JSON.stringify(windows))
console.log('hasTesseract:', m.hasTesseract())
console.log('ALL PRIMITIVES TESTS PASSED')
