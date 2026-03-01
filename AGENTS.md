# crush — agent guide

> **Keep this file under 2 000 tokens.** It is injected into every agent context window — bloat here causes context rot everywhere. Be terse. Move detail to ADRs or `LAB.md`.

## Repository layout

| Path | Purpose |
|---|---|
| `crush/` | Application code (extension, renderer, WASM integration) |
| `vendor/ghostty/` | Ghostty checkout (VT emulation core, Zig) |
| `vendor/ghostty-web/` | coder/ghostty-web checkout (WASM build + TS wrapper) |
| `voice-browser-agent/` | Reference material — existing Chrome extension with CDP automation. Do not modify. |
| `adr/` | Architecture Decision Records |
| `LAB.md` | What the browser can and can't do — confirmed capabilities, walls, open questions |
| `TODO.md` | Action items with required findings on completion |

## Conventions

### Architecture Decision Records

When making an architectural decision that selects one direction at the exclusion of alternatives, write an ADR in `adr/` following the [Nygard format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):

- **File:** `adr/NNN-short-noun-phrase.md` (numbered sequentially, never reused)
- **Sections:** Title, Status, Context, Decision, Consequences
- **Length:** One to two pages. Full sentences, not bullet fragments.
- **Lifecycle:** `proposed` → `accepted` → optionally `superseded by ADR-NNN`
- Reversed decisions stay in the repo marked as superseded — the history matters.

### No fake demos

Mocks and stubs are fine in **tests** that prove real behavior. Mocks and stubs used to make a **demo look impressive** are absolutely verboten. If a feature can't be shown working for real, show the gap honestly — don't paper over it with scripted output or puppet-string animations. Every visible behavior must be driven by real code paths.

### Code

- Application code lives in `crush/`. Do not modify `vendor/` unless applying/updating upstream patches.
- Do not modify `voice-browser-agent/` — it is reference material only.

## Known pitfalls

### Vite + WASM asset loading

Do NOT use `new URL('path/to/file.wasm', import.meta.url)` for WASM files — Vite's `@fs` resolution produces broken paths in dev. Instead, use Vite's `?url` import suffix:

```ts
import wasmUrl from '../vendor/ghostty-web/ghostty-vt.wasm?url';
const ghostty = await Ghostty.load(wasmUrl);
```

This works in both dev (Vite serves it correctly) and production (Vite copies the asset to `dist/` with a hashed name). The `vite/client` types (referenced in `src/vite-env.d.ts`) provide the type declarations for `?url` imports.

### Relative paths from `src/`

Files in `src/` are one level below the project root. To reach `vendor/` from `src/renderer.ts`, the path is `../vendor/`, NOT `../../vendor/` (which escapes the project entirely).

### SDF text pipeline — UV orientation

Canvas rasterizes glyphs top-to-bottom (row 0 = top), but `PlaneGeometry` UV v=0 is at the bottom of the quad. The shader in `BatchedText.buildMaterial` flips V accordingly. Do not "fix" this by setting `texture.flipY = true` — it will double-flip.

### Browser debugging with agent-browser

A headed Chrome runs on the host with `--remote-debugging-port=9222`. Vite dev server is on port 3000. To debug rendering in-browser:

```sh
# Get the CDP websocket URL (agent-browser needs the full ws:// URL)
curl -s http://localhost:9222/json/version | jq -r .webSocketDebuggerUrl
CDP_WS="ws://localhost:9222/devtools/browser/<id>"

# Navigate, inspect, screenshot
agent-browser --cdp "$CDP_WS" open "http://localhost:3000/sidepanel.html"
agent-browser --cdp "$CDP_WS" console        # view diagnostic logs
agent-browser --cdp "$CDP_WS" screenshot /tmp/out.png
agent-browser --cdp "$CDP_WS" eval "someJs()"
```

Do NOT use `agent-browser --cdp 9222` (bare port) — it fails. Always use the full websocket URL from `/json/version`.
