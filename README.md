# pi-vision-router

<p align="center">
  <a href="https://github.com/gallinwu/pi-vision-router/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/gallinwu/pi-vision-router/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <a href="https://github.com/gallinwu/pi-vision-router/stargazers"><img src="https://img.shields.io/github/stars/gallinwu/pi-vision-router?style=social" alt="Stars"></a>
</p>

> Your Pi model can read code but can't see your screen. **pi-vision-router gives it eyes** — vision tools over a **free, keyless** model chain, no API key, no signup, no billing.

Drop a screenshot into [`pi`](https://github.com/earendil-works/pi) and a text-only model reads it accurately: OCR of exact glyphs, element coordinates in original pixels, dominant palettes, a before/after pixel diff that proves your UI fix actually landed.

A port of [dsh-vision-router](https://github.com/ysr666/dsh-vision-router) v3.0.3 from the DSH runtime to the **Pi extension API**.

## One-click install

You need [Pi](https://github.com/earendil-works/pi) itself first. If it is not on the machine yet:

```bash
curl -fsSL https://pi.dev/install.sh | sh           # macOS / Linux
```

```powershell
powershell -c "irm https://pi.dev/install.ps1 | iex"  # Windows
```

<details open>
<summary><b>Windows</b> — PowerShell</summary>

```powershell
powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/gallinwu/pi-vision-router/main/install.ps1 -UseBasicParsing | iex"
```

</details>

<details open>
<summary><b>macOS / Linux</b> — bash</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/gallinwu/pi-vision-router/main/install.sh | bash
```

</details>

The installer resolves `pi` (or the Node CLI entry point directly), clones the repo, installs its dependencies (`sharp`, `potrace`), and **runs a load-probe to verify the extension actually mounted**. It is safe to re-run: `pi install` for an already-present git source refreshes it instead of duplicating.

### Already have the repo? One command, no script

```powershell
pi install git:github.com/gallinwu/pi-vision-router
```

`pi install` for a git source clones it, runs its own `npm install` for missing dependencies, and records it in your settings. From a local checkout: `pi install ./pi-vision-router`, or try it without installing at all:

```powershell
pi --extension ./extensions/index.ts
```

## Use it

Restart `pi` and just ask. A text-only model gets the image via `vision_describe`:

```
> [drop a screenshot in]
  what does this error say
```

On an image turn the extension caches it as `turn:1:0`, mounts the deep tools, and hands the model the ids — so it looks, it does not guess.

```powershell
pi -p "Call vision_describe on C:\path\shot.png and report the exact text"
```

Two slash commands:

| Command | What it does |
| --- | --- |
| `/see <path\|turn:n:i> <question>` | Ask the vision chain directly, bypassing the model |
| `/vision` | Status: chain size, mounted tools, settings path |

`/vision providers` · `/vision enable vision_ocr` · `/vision set desktopScreenshot=true` · `/vision reset`.

The full `/vision` output means this:

```
tool=true progressive=true routing=false
desktopScreenshot=false ocrEngine=auto (tesseract missing)
providers=5 active=2
```

`providers=5` is the healthy free chain; `active=2` is progressive mode's start (`vision_describe` + `vision_materialize`) before deep tools mount. `tesseract missing` is fine — OCR falls through to the vision model.

## Tools

**Mounted at start.**

- `vision_describe` — the main one: a focused question about 1–4 images.
- `vision_materialize` — save an image into the artifacts dir, returns an `img:<name>` id.

**Mounted on demand** (image turn, `vision_activate`, or `/vision enable <tool>`):

- `vision_ground` — element coordinates, in original pixels
- `vision_ocr` — verbatim text; local tesseract first, vision fallback
- `vision_crop` — zoom into a region, then ask about it
- `vision_detect` — structured detection over an image
- `vision_pixel_diff` — did the change actually land? differing ratio + hot cells + heatmap
- `vision_colors` — dominant palette as hex with coverage, exact pixel sampling
- `vision_trace` — raster to vector (potrace)
- `vision_extract_foreground` — cut a subject out
- `vision_screenshot` — capture the desktop (`desktopScreenshot=true`, Windows)

Progressive mounting is deliberate: ten tool schemas a turn is context you don't spend until you need it.

## Failures a model can actually route

Vision backends fail often — rate limits, timeouts, 5xx. A vague "something went wrong" makes a model re-ask, which burns a second call to the same dead backend. So every failure carries a machine-readable code and `retryable: false`:

```
VISION_AUTH_FAILED · VISION_RATE_LIMITED · VISION_TIMEOUT · VISION_BACKEND_UNAVAILABLE
VISION_BACKEND_UNAVAILABLE_THIS_TURN · VISION_UNSUPPORTED_BACKEND
```

When the chain is dead, the advice says the quiet part: **don't retry with a reworded question** — answer from what you already have. Once the chain fails, the rest of the turn short-circuits to `VISION_BACKEND_UNAVAILABLE_THIS_TURN`, so the chain is burned once per turn, not once per call.

## Providers

A keyless OVHcloud anonymous tier, largest model first so a 429 falls through to an **independent per-model bucket**:

1. `Qwen3.5-397B-A17B`
2. `Qwen2.5-VL-72B-Instruct`
3. `Qwen3.6-27B`
4. `Mistral-Small-3.2-24B-Instruct-2506`
5. `Qwen3.5-9B`

Bring your own OpenAI-compatible backend (append to the chain, keys resolved from `settings.apiKeys` then `process.env[apiKeyEnv]`, never sent for keyless providers):

```json
{
  "httpProviders": [
    { "name": "local", "baseURL": "http://127.0.0.1:11434/v1", "model": "llava", "apiKeyEnv": "" }
  ]
}
```

`localOnly: true` filters the chain to loopback hosts — nothing leaves the machine.

## Configuration

`~/.pi/agent/vision-router.json` (override with `PI_VISION_SETTINGS`), written atomically with a `.bak` of the previous file. Absent means built-in defaults.

| key | default | meaning |
| --- | --- | --- |
| `tool` | `true` | master switch for all tools |
| `progressiveTools` | `true` | start with `vision_describe` only |
| `autoActivateOnImage` | `true` | mount deep tools on an image turn |
| `exposeChainProvider` | `true` | publish the chain as selectable Pi models |
| `routing` | `false` | never short-circuit the hint for multimodal models |
| `ocrEngine` | `auto` | tesseract locally first, then vision fallback |
| `desktopScreenshot` | `false` | mount `vision_screenshot` |
| `localOnly` | `false` | restrict the chain to loopback hosts |
| `httpProviders` | `[]` | extra OpenAI-compatible rows (appended, not replacing) |
| `apiKeys` | `{}` | per-`apiKeyEnv` values; falls back to `process.env` |
| `downscale` / `downscaleMaxPixels` | `true` / `4000000` | shrink before upload |
| `taskTimeoutMs` / `perProviderTimeoutMs` | `120000` / `60000` | one deadline, sliced per provider |

## Development

```bash
npm install                                   # sharp + potrace are package-local
pi install .                                  # or: pi --extension ./extensions/index.ts
npm test                                      # offline suites, no network, no credentials
PI_VISION_LIVE=1 npm test                     # also exercise the real free chain
node tools/make-vendor.mjs                    # regenerate extensions/vendor/ from DVR source
```

`extensions/vendor/` is **generated, not hand-written**. `tools/make-vendor.mjs` slices source text verbatim out of the upstream `dsh-vision-router` clone and audits the output for DSH leftovers (`none` today), so a regeneration cannot drift. The sharp-backed helpers are re-expressed against plain sharp, dropping only DVR's resource-governor budget wrapper. The CI `vendor-drift` job re-runs the generator against the pinned upstream tag (`DVR_REF`, currently `v3.0.3`) and fails if the committed vendor tree no longer matches its output. To refresh the vendored code: run `node tools/make-vendor.mjs` against the newer clone, bump `DVR_REF` in `.github/workflows/ci.yml`, and update the header versions the generator stamps.

The default `npm test` needs no network: the chain is served by `test/mock-chain.mjs`, a local OpenAI-compatible endpoint asserting that a 429 is classified `RATE_LIMIT` and tried once, a dead provider falls through to a healthy one, a blank answer counts as failure, and keyless requests send no `Authorization` header.

**Dependency rules.** `@earendil-works/*` and `typebox` are declared as `peerDependencies: "*"`: inside Pi they resolve to the host's bundled copies through the extension loader's virtual modules, so a package-local copy would be a second runtime module with duplicated classes. `sharp`/`potrace` must stay in `dependencies` — Pi does not provide them.

The host packages are *also* listed in `devDependencies`, which is what makes `npm test` work standalone. That split is deliberate and verified: `pi install` for a git source runs `npm install --omit=dev --legacy-peer-deps`, so a published clone gets `sharp` + `potrace` only — no copy of Pi itself — while a developer's `npm ci` installs the host packages the tests import. A pristine-clone test of exactly that command confirmed both halves.

## Not ported from DVR

DVR's whole-turn `routing`/`chainRoute` rerouting — Pi tools plus the image-turn hint reach the same result without hijacking the model route; `vision_bootstrap`, `vision_long_screenshot_ocr`, `vision_present`, `vision_html_screenshot`; the attachment store; macOS/Linux screenshot capture, which the vendored Windows-only `capture-windows.js` cannot replace.

## Attribution

Vendored from [dsh-vision-router](https://github.com/ysr666/dsh-vision-router) v3.0.3, MIT © 2026 dsh-vision-router contributors. See [NOTICE](NOTICE) and [LICENSE](LICENSE).

## License

MIT — see [LICENSE](LICENSE).
