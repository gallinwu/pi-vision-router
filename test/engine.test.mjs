// End-to-end: engine chain answers a real image. No Pi, no model, no key.
import { createVisionEngine } from '../extensions/engine.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bytes = readFileSync(path.join(here, '..', 'test-fixtures', 'probe.png'))

const engine = createVisionEngine({ settings: () => ({}) })
console.log('candidates:', engine.candidates().map((p) => p.model).join(', '))

const answer = await engine.ask([{ bytes, mediaType: 'image/png' }], 'What text is in this image, and what colour is the square? Answer in one short line.')
console.log(JSON.stringify(answer, null, 2).slice(0, 1200))
if (answer.ok !== true) process.exitCode = 1
