# crush — lab notes

What we know, what we don't, what we've proven in code. Organised by browser surface area, with a section for boundaries and cross-cutting concerns.

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

✅ SDF text rendering working end-to-end — Three.js Blocks `BatchedText` renders 80×24 grid (1920 Text instances) in a single draw call via WebGPU, with per-cell color via `setColorAt()`

✅ 50+ terminal panes (80×24 = ~1920 cells each → ~100k glyph instances) is realistic with proper batching

✅ Dirty updates: update instance buffer subranges for changed cells/rows only — avoids full buffer rewrites

✅ Vite build pipeline proven for WASM + WebGPU extension: `?url` imports for WASM assets, production build copies to `dist/` with hashed names

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

### coder/ghostty-web and our integration path (see ADR-001)

✅ **[coder/ghostty-web](https://github.com/coder/ghostty-web) solves the WASM export problem.** Stock lib-vt only exports sub-parsers. ghostty-web applies a patch (`patches/ghostty-wasm-api.patch`) adding ~40 Terminal C ABI exports: lifecycle, write, resize, render state, dirty tracking, cell reading, scrollback, mode queries, DSR responses. WASM binary is 423KB (from npm package), vendored at `vendor/ghostty-web/ghostty-vt.wasm`.

✅ **`GhosttyTerminal` is a pure WASM data wrapper.** Ported into `src/ghostty/ghostty.ts` (~540 lines). No DOM, no Canvas, no events. Exposes: `write()`, `resize()`, `update()` → `DirtyState`, `isRowDirty(y)`, `getViewport()` → `GhosttyCell[]`, `getCursor()`, `getGrapheme(row, col)`, `markClean()`, scrollback APIs, mode queries, response reading. Zero-allocation cell pool internally. Entirely renderer-agnostic.

✅ **Damage tracking API is answered.** `update()` returns `DirtyState` enum: `NONE` (0), `PARTIAL` (1), `FULL` (2). FULL fires on screen switches (normal ↔ alternate). Per-row granularity via `isRowDirty(y)`. Call `markClean()` after rendering.

✅ **`GhosttyCell` is a 16-byte struct:** codepoint (u32), fg_r/g/b, bg_r/g/b, flags (bold/italic/underline/strikethrough/inverse/invisible/blink/faint as bitfield), width, hyperlink_id (u16), grapheme_len. Colors are pre-resolved to RGB by WASM — no palette lookup needed on JS side.

✅ **`KeyEncoder` (also in `lib/ghostty.ts`) is renderer-agnostic.** Converts keyboard events to terminal escape sequences using ghostty's key encoding. Usable independently of the Terminal class.

✅ **ghostty-web's `Terminal` class and `CanvasRenderer` are NOT used.** They couple Canvas 2D rendering, DOM elements, scrollbar animations, and xterm.js event patterns. We use `GhosttyTerminal` directly. See ADR-001.

⚠️ WASM threads require `SharedArrayBuffer` which requires cross-origin isolation (COOP+COEP) — MV3 can configure this but adds complexity

⚠️ Unicode width/grapheme handling must be deterministic and match common terminal behaviour

⚠️ ghostty-web's WASM patch must stay compatible with ghostty upstream — patch is minimal, maintainers track upstream, but drift is possible on major ghostty releases

❌ Cannot run a local PTY in the browser — no subprocess spawning

❌ To connect to a real shell: need Native Messaging host (local helper binary) or remote shell over WebSocket/SSH

❓ Single-threaded WASM performance for VT parsing — is it fast enough, or will we need threads?

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

---

## Storage architecture (ADR-002)

✅ **chrome.storage.local for API keys and settings.** Keys stored under `crush:auth:<provider>`, settings under `crush:settings`. Available in all extension contexts. `StorageBackend` interface with `ChromeStorageBackend` (real) and `MemoryStorageBackend` (testing).

✅ **OPFS for workspace files.** `WorkspaceFS` interface with `readText`, `writeText`, `list`, `exists`, `mkdirp`, `remove`. `OpfsWorkspaceFS` stores under `crush/workspaces/<id>/` in OPFS. `MemoryWorkspaceFS` for testing. Agent file tools call through WorkspaceFS, never OPFS directly.

✅ **Agent loop runs in side panel** — both OPFS and chrome.storage.local are accessible. No service worker suspension issues.

✅ **`"storage"` permission** added to manifest.json. `host_permissions` for `api.anthropic.com` added for direct LLM fetch from side panel.

⚠️ OPFS is wiped on extension uninstall — not durable for user-critical files

❓ File System Access API (`showDirectoryPicker`) for real disk access — future `FsaWorkspaceFS` implementation

❓ IndexedDB for conversation history search/indexing — deferred

---

## CrushProgram interface

✅ **Programs are async functions** that receive a `ProgramContext` with `stdout`, `stdin`, `args`, and `term`. `run()` returns `Promise<number>` (exit code).

✅ **Foreground program model:** when a program is running, `LocalShell.feed()` routes all keystrokes to the program's `StdinStream` instead of the shell's line editor. When the program exits (promise resolves), the shell resumes with a new prompt.

✅ **stdin is an `AsyncIterable<string>`** backed by `StdinStream`. The shell pushes raw keystroke data; programs consume via `for await (const chunk of ctx.stdin)`. `StdinStream.close()` signals EOF.

✅ **One-shot programs** (echo, help, clear, colors, date) write to stdout and return immediately — stdin is never read.

✅ **Interactive programs** (future: agent chat, browser automation) read from stdin in a loop. They own their own line editing, prompt rendering, and input interpretation.

✅ **Command registry** in `LocalShell.commands` maps command names to `CrushProgram` instances. `registerCommand()` adds commands at runtime.

❓ Future context fields: `chrome` (RPC to service worker for CDP/tabs), `scene` (THREE.js scene for 3D rendering). Not yet wired.

❓ Signal handling (Ctrl+C to interrupt a running program) — currently keystrokes go to the program's stdin; the program must handle ^C itself. May want a shell-level kill mechanism.
