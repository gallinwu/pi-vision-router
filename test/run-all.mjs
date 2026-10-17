// Whole-suite entry point: npm test
//
// Offline by default. The mock-backed suites need no network and no credentials,
// so this is what CI runs. The live suites exercise the real free vision chain;
// they are opt-in via PI_VISION_LIVE=1 because a free tier is not a test fixture.
import { spawnSync } from 'node:child_process'

const LIVE = process.env.PI_VISION_LIVE === '1'

const offline = [
  ['primitives', 'test/primitives.test.mjs'],
  ['offline chain', 'test/offline.test.mjs'],
  ['failure semantics', 'test/failure.test.mjs'],
  ['deep tools', 'test/deep-tools.test.mjs'],
]

const live = [
  ['tools (live)', 'test/tools.test.mjs'],
  ['live chain', 'test/engine.test.mjs'],
]

const suites = LIVE ? [...offline, ...live] : offline

let failed = 0
for (const [label, file] of suites) {
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  const last = (run.stdout.trim().split('\n').pop() ?? '').trim()
  const ok = run.status === 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} ${last}`)
  if (!ok) console.log((run.stderr ?? '').split('\n').slice(0, 12).join('\n'))
}

if (!LIVE) {
  console.log('\n(live chain suites skipped -- set PI_VISION_LIVE=1 to include them)')
}
console.log(failed === 0 ? '\nALL SUITES PASSED' : `\n${failed} SUITE(S) FAILED`)
process.exitCode = failed === 0 ? 0 : 1
