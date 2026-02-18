# ADR 1: GhosttyTerminal as WASM integration layer

## Status

Accepted.

## Context

Crush needs a VT emulation core running in the browser to process terminal byte streams and produce a cell grid that our Three.js WebGPU SDF renderer can consume. The pipeline is: bytes in → VT state machine → cell grid + damage flags → renderer reads cells → GPU.

Ghostty's libghostty-vt compiles cleanly to WASM (`wasm32-freestanding`, ~400KB, 1 import: `env.log`). However, the stock C API only exports sub-parsers — OSC, SGR, key encoding, paste safety. It does not export Terminal, Screen, or the cell-reading APIs needed for the feed→damage→read-cells pipeline.

[coder/ghostty-web](https://github.com/coder/ghostty-web) solves this. It applies a patch (`patches/ghostty-wasm-api.patch`) adding ~40 Terminal C ABI exports: `ghostty_terminal_new`, `ghostty_terminal_write`, `ghostty_render_state_update`, `ghostty_render_state_get_viewport`, dirty tracking, scrollback, mode queries, and device status response handling. The WASM binary with these exports is ~404KB.

On top of the WASM binary, ghostty-web provides three TypeScript layers:

1. **`GhosttyTerminal`** (`lib/ghostty.ts`, ~540 lines) — a pure WASM wrapper. No DOM, no Canvas, no event handling. Exposes: `write()`, `resize()`, `free()`, `update()` → `DirtyState`, `isRowDirty(y)`, `getViewport()` → `GhosttyCell[]`, `getLine(y)`, `getCursor()`, `getGrapheme(row, col)`, scrollback APIs, terminal mode queries, and DSR response reading. Uses a zero-allocation cell pool internally. Entirely renderer-agnostic.

2. **`CanvasRenderer`** (`lib/renderer.ts`, ~980 lines) — a Canvas 2D renderer. Reads from an `IRenderable` interface. Handles font metrics, DPI scaling, cursor blinking, selection highlighting, scrollbar rendering. Irrelevant to us since we are building a Three.js WebGPU SDF renderer.

3. **`Terminal`** (`lib/terminal.ts`, ~1800 lines) — the xterm.js-compatible public API. Wires together GhosttyTerminal + CanvasRenderer + InputHandler + SelectionManager + link detection + scrollbar + DOM elements (`<canvas>`, `<textarea>`). Tightly coupled to Canvas 2D rendering and DOM event handling.

The question is which of these layers to use. Three options were considered:

**Option A: Use the full `Terminal` class.** This gives xterm.js API compatibility, input handling, selection, scrollback viewport management, and DSR response processing out of the box. But it is coupled to Canvas 2D rendering and DOM management. We would need to either rip out the CanvasRenderer and replace it, or fight its assumptions about how rendering works. The class creates DOM elements on `open()`, manages scrollbar fade animations, handles mouse events for link detection — none of which apply to a Three.js scene.

**Option B: Use `GhosttyTerminal` directly.** This gives us exactly the data pipeline we need — write bytes, get dirty flags, read cells — with zero rendering opinions. We build input handling, selection, and viewport management ourselves, tailored to our Three.js 3D terminal pane architecture. More work upfront, but no impedance mismatch.

**Option C: Use neither; write our own thin wrapper on the raw WASM C ABI.** `GhosttyTerminal` is already this wrapper — ~540 lines, tested, with sensible memory management (cell pools, buffer reuse, grapheme lookup). Rewriting it would duplicate work for no benefit.

## Decision

We will use `GhosttyTerminal` from coder/ghostty-web as our WASM integration layer. We will not use the `Terminal` class, `CanvasRenderer`, `InputHandler`, or `SelectionManager`.

Our Three.js SDF renderer will call `GhosttyTerminal` directly:

1. `write(data)` — feed byte stream from shell/PTY
2. `update()` — sync render state, get `DirtyState` (NONE / PARTIAL / FULL)
3. `isRowDirty(y)` — check which rows changed
4. `getViewport()` — read all cells as `GhosttyCell[]` (16-byte structs: codepoint, fg_rgb, bg_rgb, flags, width, hyperlink_id, grapheme_len)
5. `getGrapheme(row, col)` — resolve multi-codepoint grapheme clusters
6. `markClean()` — reset dirty state after render

Input handling, selection, scrollback viewport management, and any DOM interaction will be built separately in `crush/`, designed for the Three.js 3D pane model rather than a 2D canvas.

The ghostty-web repository is vendored at `vendor/ghostty-web/`. We import `GhosttyTerminal` and its types from `vendor/ghostty-web/lib/ghostty.ts`. The pre-built WASM binary (`ghostty-vt.wasm`, ~404KB) is committed in that vendor directory.

## Consequences

The `GhosttyCell` struct becomes the contract between VT emulation and rendering. Our Three.js SDF renderer reads this struct to populate GPU instance buffers. Any change to the cell format (upstream patch updates) requires updating both sides.

We take on responsibility for input handling, selection, and viewport scrolling. These are non-trivial but can be built incrementally and tailored to the 3D pane model. ghostty-web's implementations in `InputHandler`, `SelectionManager`, and `Terminal` serve as reference for escape sequence generation, selection coordinate math, and scrollback viewport management.

We depend on ghostty-web's WASM patch staying compatible with ghostty upstream. The patch is minimal (~40 C ABI exports on top of stock lib-vt) and the ghostty-web maintainers track upstream. If the patch drifts, we can pin the ghostty submodule to a known-good commit.

The `KeyEncoder` class from ghostty-web (also in `lib/ghostty.ts`) is useful and renderer-agnostic. We will likely use it for keyboard input encoding when we build input handling.
