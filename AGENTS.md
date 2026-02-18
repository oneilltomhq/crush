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
