# crush — action items

Each task requires a **Findings** entry on completion: the answer, outcome, or clarity that renders the original question obsolete.

---

## Shell layer

- [ ] **#8 — Side panel ↔ offscreen document handoff**
  Question: Can the agent runtime survive side panel close?
  Task: Minimal PoC extension — start a counter in side panel, close panel, confirm offscreen document picks up, reopen panel, confirm state resumes.
  Findings: _pending_

- [ ] **#10 — Service worker lifecycle (parked — may dissolve after #8)**
  Question: Does the SW dying mid-operation break the agent loop?
  Task: If #8 shows the SW is a thin relay that re-spawns on `chrome.runtime.sendMessage()`, this is a non-issue. Only investigate if #8 reveals a real problem.
  Findings: _pending_

- [ ] **#5 — Scroll command**
  Task: Add `Input.dispatchMouseEvent` with `type: 'mouseWheel'` to commands.ts. Same pattern as existing click command.
  Findings: _pending_

- [ ] **#6 — Hover command**
  Task: Add `Input.dispatchMouseEvent` with `type: 'mouseMoved'` to commands.ts. Same pattern as existing click command.
  Findings: _pending_

- [ ] **#7 — Select (dropdown) command**
  Task: `Runtime.evaluate` to set `<select>` value + dispatch change event. Confirm it works with React/framework-controlled selects.
  Findings: _pending_

## Rendering layer

- [ ] **#3 — OffscreenCanvas + Worker WebGPU in extension contexts**
  Question: Can the WebGPU renderer run in a Dedicated Worker via `OffscreenCanvas` inside a Chrome extension?
  Task: Research only — check Chrome platform status, extension context restrictions, and spec compatibility. No code needed.
  Findings: _pending_

- [x] **#9 — Tab capture → WebGPU texture (basic pipeline proven)**
  Question: How many simultaneous live tab streams can we render as 3D panes before performance degrades?
  Task: Minimal PoC pipeline — `tabCapture` → `<video>` → `<canvas>` → `GPUExternalTexture`. Measure FPS/latency at 1, 2, 3, 4 simultaneous streams.
  Findings: Pipeline proven via CDP `Page.startScreencast` → WebSocket relay → `BrowserTexture` (JPEG decode → Canvas2D → `THREE.CanvasTexture`). Single stream works cleanly at ~5-10 fps screencast rate. Used server-side relay (`server/cdp-relay.ts`) instead of `chrome.tabCapture` — works from any web page, not just extension context. Multi-stream stress test still pending (need #9b).

- [ ] **#9b — Multi-stream stress test**
  Question: How many simultaneous CDP screencast streams can we relay before performance degrades?
  Task: Extend cdp-relay to support multiple tabs. Measure at 2, 4, 8 simultaneous streams.
  Findings: _pending_

- [x] **#1 — libghostty-vt separability (confirmed — see surface.md)**
  Question: Is the VT core separable from PTY/OS deps?
  Answer: **Yes.** Parser → Terminal → Screen → Page chain has zero OS dependencies. WASM build infrastructure exists in ghostty (wasm32 detection, C ABI exports, custom allocator path). Page uses `initBuf()` for pre-allocated buffers, bypassing `posix.mmap()`. SIMD is optional — disable it to avoid libc linkage.
  Status: Research complete. Feeds directly into #12.
  Findings: Separable. surface.md updated with confirmed details. Full librarian analysis in thread T-019c6c97-c0b8-7646-ad78-f04099a1182a.

- [ ] **#12 — WASM VT emulator spike**
  Depends on: #1 (done), ADR-001 (accepted — use GhosttyTerminal directly)
  Task sequence:
  1. Use pre-built WASM binary from `vendor/ghostty-web/ghostty-vt.wasm` (~404KB)
  2. Import `GhosttyTerminal` from `vendor/ghostty-web/lib/ghostty.ts`, instantiate in a Dedicated Worker
  3. Feed test byte streams via `write()`, exercise `update()` → `isRowDirty()` → `getViewport()` → `markClean()` cycle
  4. Measure: parse throughput (bytes/sec), memory footprint, cell read latency, WASM↔JS boundary overhead
  5. Verify the `GhosttyCell` struct (16 bytes: codepoint, fg/bg RGB, flags, width, hyperlink_id, grapheme_len) carries enough info for SDF rendering
  Findings: _pending_

## Dropped

- ~~#11 — Network interception wrapper~~ — Not core to what we're building.
