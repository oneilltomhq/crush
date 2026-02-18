# crush — technical surface

What we know, what we don't. Organised by browser surface area, with a section for boundaries and cross-cutting concerns.

Legend: **✅ confirmed** · **⚠️ possible but hard/fragile** · **❌ hard wall** · **❓ open question**

---

## chrome.debugger / CDP

✅ Per-tab automation is near Playwright parity: navigate, click, type, screenshot, snapshot, JS eval — all work via `chrome.debugger` with protocol version `"1.3"`

✅ Network observation: `Network.enable` + `Network.getResponseBody` can read response bodies regardless of page CORS (tab-scoped, requires attachment)

✅ DOM/CSS: full read/write via `DOM.*`, `CSS.*`, `DOMSnapshot.*`

✅ Input synthesis: `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`

⚠️ Network interception via `Fetch.enable` / `Fetch.requestPaused` is powerful but easy to deadlock pages if you miss continuations, redirects, auth challenges, streaming bodies

⚠️ Cross-origin iframes / OOPIFs need frame-aware targeting and separate execution contexts

⚠️ File uploads: CDP has `DOM.setFileInputFiles` but extensions can't enumerate local files or obtain absolute paths — only works if user provides files through extension UI

⚠️ CDP method availability drifts across Chrome versions — `chrome.debugger.attach` uses a protocol version string, newer methods may not exist on stable

⚠️ Only one debugger client per target — if user opens DevTools, you get `onDetach`

⚠️ "Browser target" CDP features (global permissions, creating contexts) are not well-supported from `chrome.debugger` — treat as fragile

❌ Cannot attach to `chrome://` pages, `chrome-extension://` pages of other extensions, or Chrome Web Store pages

❌ Cannot auto-dismiss Chrome's own permission prompts/dialogs (camera, mic, geolocation, notifications)

❌ Chrome may show "controlled by automated software" infobar when debugger is attached

❓ Exactly which CDP domains/methods work on a given Chrome stable version — needs a test matrix

❓ Can we reliably attach to browser-target CDP from an extension at all?

---

## Service worker (MV3 background)

✅ Can call all privileged extension APIs: `chrome.debugger`, `chrome.tabs`, `chrome.storage`, etc.

✅ Good as an event router / RPC bridge between extension contexts

❌ Ephemeral: Chrome can suspend after ~30s idle, hard-kill after ~5min of a long event handler

❌ Global variables reset on every restart — in-memory state is not durable

❌ In-flight async (e.g. LLM streaming fetch) is aborted on termination

❌ No DOM — cannot render, cannot use WebGPU canvas, cannot show file pickers

❌ Timers (`setTimeout`, `setInterval`) are unreliable under suspension

⚠️ Keepalive hack: periodically calling a trivial extension API (e.g. `chrome.runtime.getPlatformInfo`) resets the idle timer (~20-25s interval) — works but explicitly discouraged for general extensions

**→ Use the SW as a thin privileged RPC layer, not the agent runtime.**

---

## Side panel

✅ Real extension page: full DOM, any frontend framework, WebGPU canvas rendering

✅ Stays alive as long as it's open — most reliable host for a long-running agent loop

✅ Can communicate with SW via `chrome.runtime.connect` (long-lived ports) or `sendMessage`

✅ Can use File System Access API pickers (`showOpenFilePicker`, etc.) with a user gesture

✅ Can use OPFS (`navigator.storage.getDirectory()`) for sandboxed file storage

✅ Can spawn Dedicated Workers (for WASM, OPFS `createSyncAccessHandle`, compute)

⚠️ Not guaranteed to stay open — user can close it, Chrome can suspend

⚠️ Only `chrome.runtime` API available directly — everything else mediated through SW

**→ Primary candidate for agent runtime + renderer.**

---

## Offscreen document (`chrome.offscreen`)

✅ Hidden extension page with real DOM — can run long-lived loops, WebSockets, WASM

✅ Can spawn Dedicated Workers

✅ Good for background agent continuation when side panel is closed

⚠️ Only one per profile

⚠️ Only `chrome.runtime` API available — everything else via SW

⚠️ Cannot show UI, not focusable — file pickers don't work

⚠️ Lifespan not formally guaranteed — design for restart/resume

⚠️ Must provide a valid `reason` + justification; Chrome may tighten acceptable reasons

**→ Use for background continuation, but architect as resumable.**

---

## Tab and window management

✅ Full CRUD: `chrome.tabs` create, update, reload, close, move, group, query

✅ `chrome.windows` create, focus, move, close

✅ Can read `url/title/favIconUrl/status` (subject to host permissions)

✅ `chrome.scripting.executeScript({world: "MAIN"})` can access page JS variables directly

❌ Cannot read DOM/HTML without debugger attachment, content scripts, or `scripting.executeScript`

---

## Screen / tab capture

✅ `Page.captureScreenshot` (CDP) for single-frame screenshots of attached tab

✅ `chrome.tabs.captureVisibleTab` for visible tab content (simpler, no debugger needed)

✅ `chrome.tabCapture` captures a tab as a `MediaStream` (audio/video)

✅ MediaStream → `<canvas>` → frame extraction → can feed a vision model

⚠️ 1 tab capture at 30-60fps: feasible

⚠️ 2-4 simultaneous captures: maybe, hardware-dependent

⚠️ Many simultaneous live tab textures: likely the first hard ceiling (decode + copy + upload)

⚠️ CDP screencast (`Page.startScreencast`) works but lower FPS, higher latency, CPU-heavy

⚠️ `desktopCapture` requires a user selection prompt — not silent/seamless

⚠️ Capturing non-active/background tabs is permission- and UX-constrained

❌ DRM/protected video content often renders as black frames

❌ Capture processing needs side panel or offscreen document — SW can't handle `MediaStream`

❓ Practical FPS/latency numbers for `tabCapture` → canvas → WebGPU texture pipeline

❓ Can `VideoFrame` / WebCodecs provide a more efficient path (fewer copies)?

---

## File system access

✅ File System Access API pickers work from side panel and extension pages (user gesture required)

✅ OPFS works without prompts — sandboxed, no user interaction needed

✅ File handles can be persisted in IndexedDB across sessions (must re-check/request permission on reuse)

✅ `createSyncAccessHandle()` for high-perf random access — but only in Dedicated Workers

⚠️ Users can revoke access; handles can become invalid; UI must handle re-picking

❌ No arbitrary filesystem traversal — only user-selected locations or OPFS sandbox

❓ `FileSystemObserver` API — evolving, limited to directories you hold handles for, not something to bet on yet

---

## WebGPU rendering

✅ WebGPU available in extension pages (side panel, extension tab, options page) — they're secure contexts

✅ SDF/MSDF terminal text rendering is proven feasible — instanced quads with glyph atlas, one/few draw calls

✅ 50+ terminal panes (80×24 = ~1920 cells each → ~100k glyph instances) is realistic with proper batching

✅ Dirty updates: update instance buffer subranges for changed cells/rows only — avoids full buffer rewrites

✅ MSDF generally better than single-channel SDF for small terminal fonts

⚠️ Popup is technically possible but short-lived and throttled — not suitable for continuous rendering

⚠️ Enterprise policies or older Chrome/GPU configs can disable WebGPU — need fallback strategy if wide compat matters

❌ Cannot render in service worker (no DOM, no canvas)

❌ Cannot share GPUDevice, textures, or buffers across separate extension pages (side panel vs tab vs popup)

❌ Each context gets its own renderer — sync state via messaging, not GPU resources

❓ OffscreenCanvas + Dedicated Worker for WebGPU rendering — does this work in extension contexts? Performance?

---

## libghostty-vt / WASM terminal emulation

✅ Terminal emulation in WASM is proven (xterm.js exists in JS; Rust→WASM compilation is mature)

✅ **libghostty-vt is separable.** Parser → Terminal → Screen → Page chain has zero OS dependencies. PTY/termios/subprocess live in entirely separate modules (`src/pty.zig`, `src/termio.zig`, `src/os/`). Not in the VT core dependency chain.

✅ **WASM build infrastructure already exists in ghostty.** `build.zig` has `wasm32` detection, `GhosttyLibVt.initWasm()` build path, C ABI exports in `lib_vt.zig`, and `std.heap.wasm_allocator` integration.

✅ **Page buffer allocation works without mmap.** `Page.initBuf()` accepts pre-allocated buffers, bypassing `posix.mmap()`. Compatible with WASM allocators.

✅ **SIMD is optional.** Disabling it removes libc/libcpp linkage — clean WASM target.

✅ **API matches feed/damage pattern.** `Stream.nextSlice([]const u8)` feeds bytes → Parser returns `Action` → Terminal updates state → per-row `dirty` flags track damage → cells readable via `Page.Cell` (codepoint, style_id, wide/narrow, hyperlink).

✅ Build target: `wasm32-freestanding` (Zig, not Rust — ghostty is Zig)

⚠️ WASM threads require `SharedArrayBuffer` which requires cross-origin isolation (COOP+COEP) — MV3 can configure this but adds complexity

⚠️ Unicode width/grapheme handling must be deterministic and match common terminal behaviour

❌ Cannot run a local PTY in the browser — no subprocess spawning

❌ To connect to a real shell: need Native Messaging host (local helper binary) or remote shell over WebSocket/SSH

❓ Single-threaded WASM performance for VT parsing — is it fast enough, or will we need threads?

❓ What does the damage tracking API actually look like? Does it report changed rows/rects efficiently?

---

## Boundaries and cross-cutting concerns

### Architecture: who owns what

The natural split based on everything above:

| Concern | Owner |
|---|---|
| Agent loop + LLM streaming | Side panel (primary) or offscreen doc (background) |
| WebGPU rendering | Side panel (canonical render surface) |
| Privileged APIs (`chrome.debugger`, `chrome.tabs`) | Service worker (RPC bridge) |
| WASM terminal emulation | Dedicated Worker (spawned from side panel) |
| Persistent state | `chrome.storage` / IndexedDB / OPFS |
| File I/O (user files) | Side panel via pickers; OPFS via Dedicated Worker |

### Shared rendering across contexts

❌ Cannot share GPU resources across extension pages — side panel, tabs, popups are isolated

✅ Tabs as 3D panes should be logical constructs inside a single render surface, not separate canvases

✅ Content scripts in pages should be lightweight capture/control hooks, not renderers

✅ State sync between contexts via `chrome.runtime.connect` / `sendMessage` / storage

### Tab capture → WebGPU texture pipeline

The path: `tabCapture` → `MediaStream` → `<video>` → `<canvas>` (2D) → upload to GPU texture

⚠️ This is the most resource-constrained pipeline — likely caps at 2-4 simultaneous live textures

❓ Can `VideoFrame` / WebCodecs → WebGPU external texture reduce copies?

❓ Adaptive strategy: 1 "active" live stream + others as periodic snapshots?

### Agent runtime lifecycle

Side panel open → agent loop runs in side panel JS
Side panel closed → can migrate to offscreen document (resumable)
SW is always the privileged API bridge but never the loop host
State must be persisted frequently — any context can die

❓ What's the handoff pattern between side panel and offscreen document? How do we make it seamless?

### agent-browser parity

The 8 commands already PoC'd in `voice-browser-agent` (navigate, snapshot, click, type, pressKey, screenshot, evaluate, waitForLoad) cover the core agent-browser surface via `chrome.debugger`/CDP.

❓ What's missing for full parity? Likely: scroll, hover, select, check/uncheck, drag, upload, network interception, PDF export

❓ Do we need parity, or is "good enough for an LLM agent loop" a different (smaller) surface?
