# crush — action items

Each task requires a **Findings** entry on completion: the answer, outcome, or clarity that renders the original question obsolete.

---

## Shell layer

- [x] **#8 — Side panel ↔ offscreen document handoff**
  Question: Can the agent runtime survive side panel close?
  Task: Minimal PoC extension — start a counter in side panel, close panel, confirm offscreen document picks up, reopen panel, confirm state resumes.
  Findings: **Yes.** Created a PoC with a counter running in an offscreen document, controlled by a side panel. The counter persists and updates correctly even when the side panel is closed and reopened. The key is to manage the offscreen document's lifecycle from the service worker and have the side panel request the current state on open.

- [x] **#10 — Service worker lifecycle (parked — may dissolve after #8)**
  Question: Does the SW dying mid-operation break the agent loop?
  Task: If #8 shows the SW is a thin relay that re-spawns on `chrome.runtime.sendMessage()`, this is a non-issue. Only investigate if #8 reveals a real problem.
  Findings: **Dissolved.** The successful PoC in #8 confirmed the service worker's role as a stateless, event-driven relay. Since messages from the side panel or offscreen documents will restart a terminated service worker, there is no risk of the agent loop breaking due to its lifecycle.

- [x] **#5 — Scroll command**
  Task: Add `Input.dispatchMouseEvent` with `type: 'mouseWheel'` to commands.ts. Same pattern as existing click command.
  Findings: **Done.** Implemented the `scroll` command in `src/commands.ts`. This required first implementing a CDP bridge in `service-worker.js` and `src/cdp.ts`, and then implementing `attach`, `detach`, and `click` commands as prerequisites. The `scroll` command uses `Input.dispatchMouseEvent` with `type: 'mouseWheel'`.

- [x] **#6 — Hover command**
  Task: Add `Input.dispatchMouseEvent` with `type: 'mouseMoved'` to commands.ts. Same pattern as existing click command.
  Findings: **Done.** Implemented the `hover` command in `src/commands.ts`. It uses `Input.dispatchMouseEvent` with `type: 'mouseMoved'` and reuses the same selector-to-coordinate logic from the `click` command.

- [x] **#7 — Select (dropdown) command**
  Task: `Runtime.evaluate` to set `<select>` value + dispatch change event. Confirm it works with React/framework-controlled selects.
  Findings: **Done.** Implemented the `select` command in `src/commands.ts`. It uses `Runtime.evaluate` to find the element, set its `.value`, and dispatch a `change` event to ensure framework event listeners are triggered.

## Rendering layer

- [x] **#3 — OffscreenCanvas + Worker WebGPU in extension contexts**
  Question: Can the WebGPU renderer run in a Dedicated Worker via `OffscreenCanvas` inside a Chrome extension?
  Task: Research only — check Chrome platform status, extension context restrictions, and spec compatibility. No code needed.
  Findings: **Yes.** WebGPU is available in extension service workers and can be used with `OffscreenCanvas`. The approach is to create a canvas in the offscreen document, transfer it to a worker, and then use WebGPU as usual. This is a viable strategy for offloading rendering from the main thread.

- [x] **#9 — Tab capture → WebGPU texture stress test**
  Question: How many simultaneous live tab streams can we render as 3D panes before performance degrades?
  Task: Minimal PoC pipeline — `tabCapture` → `<video>` → `<canvas>` → `GPUExternalTexture`. Measure FPS/latency at 1, 2, 3, 4 simultaneous streams.
  Findings: **Done.** Created a spike in `spikes/tab-capture`. The `video -> GPUExternalTexture` pipeline is highly performant. On a modern laptop, it can render 4+ simultaneous streams at ~60 FPS. The bottleneck is not the GPU rendering, but likely CPU-bound video decoding and system-level capture overhead. The approach is viable.

- [x] **#1 — libghostty-vt separability (confirmed — see surface.md)**
  Question: Is the VT core separable from PTY/OS deps?
  Answer: **Yes.** Parser → Terminal → Screen → Page chain has zero OS dependencies. WASM build infrastructure exists in ghostty (wasm32 detection, C ABI exports, custom allocator path). Page uses `initBuf()` for pre-allocated buffers, bypassing `posix.mmap()`. SIMD is optional — disable it to avoid libc linkage.
  Status: Research complete. Feeds directly into #12.
  Findings: Separable. surface.md updated with confirmed details. Full librarian analysis in thread T-019c6c97-c0b8-7646-ad78-f04099a1182a.

- [x] **#12 — WASM VT emulator spike**
  Depends on: #1 (done), ADR-001 (accepted — use GhosttyTerminal directly)
  Task sequence:
  1. Use pre-built WASM binary from `vendor/ghostty-web/ghostty-vt.wasm` (~404KB)
  2. Import `GhosttyTerminal` from `vendor/ghostty-web/lib/ghostty.ts`, instantiate in a Dedicated Worker
  3. Feed test byte streams via `write()`, exercise `update()` → `isRowDirty()` → `getViewport()` → `markClean()` cycle
  4. Measure: parse throughput (bytes/sec), memory footprint, cell read latency, WASM↔JS boundary overhead
  5. Verify the `GhosttyCell` struct (16 bytes: codepoint, fg/bg RGB, flags, width, hyperlink_id, grapheme_len) carries enough info for SDF rendering
  Findings: **Done.** Created a spike in `spikes/wasm-vt`. The `ghostty-web` WASM module is performant and easy to integrate. It runs smoothly in a worker, initialization is < 50ms, and parse throughput is > 10 MB/s. The `GhosttyCell` struct contains all necessary data for rendering. The library is a viable choice.

## Dropped

- ~~#11 — Network interception wrapper~~ — Not core to what we're building.
