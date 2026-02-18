# crush — agent guide

## Repository layout

| Path | Purpose |
|---|---|
| `crush/` | Application code (extension, renderer, WASM integration) |
| `vendor/ghostty/` | Ghostty checkout (VT emulation core, Zig) |
| `vendor/ghostty-web/` | coder/ghostty-web checkout (WASM build + TS wrapper) |
| `voice-browser-agent/` | Reference material — existing Chrome extension with CDP automation. Do not modify. |
| `adr/` | Architecture Decision Records |
| `surface.md` | Technical surface area — confirmed capabilities, walls, open questions |
| `TODO.md` | Action items with required findings on completion |

## Conventions

### Architecture Decision Records

When making an architectural decision that selects one direction at the exclusion of alternatives, write an ADR in `adr/` following the [Nygard format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):

- **File:** `adr/NNN-short-noun-phrase.md` (numbered sequentially, never reused)
- **Sections:** Title, Status, Context, Decision, Consequences
- **Length:** One to two pages. Full sentences, not bullet fragments.
- **Lifecycle:** `proposed` → `accepted` → optionally `superseded by ADR-NNN`
- Reversed decisions stay in the repo marked as superseded — the history matters.

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

### Three.js Blocks — BatchedText per-instance color

`Text.color` can be set before adding to a batch, but to update color at runtime on a `BatchedText`, you must:
1. Store the instance ID returned by `batchedText.addText(text)`
2. Use `batchedText.setColorAt(instanceId, color)` with a `THREE.Color`

Do NOT call `textInstance.color.setRGB()` on batched members — it does not propagate to the GPU buffers.

### Three.js Blocks — LLM documentation

Three.js Blocks publishes LLM-optimized docs. Before guessing at the API, read them:
- Index: `https://www.threejs-blocks.com/llm/core/llms.txt`
- Full API: `https://www.threejs-blocks.com/llm/core/llms-full.txt`
