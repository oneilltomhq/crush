# ADR 004: Server-authoritative architecture — browser as thin client

## Status

Accepted

## Context

Crush started as a browser-native agent shell delivered entirely as a Chrome extension. The thesis was that the browser is already a sandbox with a permission model, every user has one, and agents inherit the user's cookies, auth state, and extensions. The Manifest V3 extension would own the agent runtime, privileged APIs (CDP, tabs), terminal emulation (Ghostty WASM), and a 3D spatial renderer (Three.js / WebGPU). Everything lived client-side.

Several things challenged this as we built:

1. **No real shell.** The WASM terminal can emulate a VT and run a toy `LocalShell`, but it cannot run `git`, `gh`, `cargo`, or any actual development tooling. A real shell requires a PTY on a real OS. The extension cannot provide one.

2. **Network locality.** The CDP tab capture proof (commit `58e584c`) used a WebSocket relay server on localhost. This works when the browser and server are on the same machine, but breaks the moment the user is on a different network — which is the normal case for a cloud VM like exe.dev.

3. **Session persistence.** The strongest argument for server-side: processes on a remote host keep running after the user closes their laptop or loses connection. An extension-only architecture dies when the browser tab closes. Offscreen documents and service worker tricks (#8, #10 in TODO) might extend the lifetime, but they fight the browser's resource-reclamation model rather than working with it.

4. **The relay proved the pattern.** The CDP relay (`server/cdp-relay.ts`) is a WebSocket server that streams screencast frames to any web client. It worked from `grid.html` standalone — no extension context needed. This was the proof that the server-side relay pattern is both simpler and more capable than the extension-native path.

Meanwhile, the rendering layer — Three.js WebGPU, SDF text, Ghostty WASM terminal emulation, spatial pane navigation — works well in any browser context. It doesn't need extension APIs. It just needs data to display.

## Decision

Crush adopts a server-authoritative architecture:

- **Server** (daemon on a Linux host like exe.dev): owns agent runtime, PTY sessions, CDP automation, filesystem, tool execution, LLM API calls, and all persistent state. Exposes WebSocket endpoints for terminals, browser streams, and agent control.

- **Client** (browser): owns rendering (Three.js / WebGPU spatial scene), input capture, and connection management. Connects to the server over WebSocket(s). Has no privileged logic of its own — it is a viewport into server-side resources.

The Chrome extension is no longer load-bearing. CDP automation moves server-side (the relay already proved this). Tab capture is replaced by server-side screencast. Side Panel is just an iframe. `chrome.storage` is just localStorage. The client is a web page, not an extension.

The resource graph (ADR 003) already anticipated this split via URI schemes (`wasm://`, `pty://`, `cdp://`). This decision makes `pty://<host>` and `ws://<host>` the primary resource locators, with `wasm://` as a local-only fallback.

For terminal rendering, the client keeps ghostty-web (coder/ghostty-web). It is an xterm.js-style library that wraps Ghostty's VT emulation core compiled to WASM. The `Terminal` class has the standard web-terminal API (`open()`, `write()`, `onData`, `resize()`, `FitAddon`, etc.), and the lower-level `GhosttyTerminal` gives direct access to the cell grid (`getViewport()` → `GhosttyCell[]` with codepoint, fg/bg RGB, flags) — exactly what `TerminalTexture` uses to render terminal content onto Three.js pane textures. Connecting to a server-side PTY is trivial: pipe WebSocket binary frames into `term.write()`, pipe `onData` back over the socket. No special addon needed.

## Consequences

1. **The server is required.** Crush without a server is a demo, not a tool. This is an explicit trade-off: we lose the "just install the extension" simplicity in exchange for real capability (persistent sessions, real shells, real tools). The server is a plain Linux process with no platform-specific dependencies — it runs on any VPS, cloud VM, or local machine.

2. **The R&D is preserved.** The Ghostty WASM integration, `TerminalTexture`, `BrowserTexture`, `BatchedText` SDF rendering, spatial navigation, depth drill-down — all of this remains. It is the client. The tag `v0.1-browser-native` marks the end of the browser-only era; the code continues forward.

3. **WebSocket is the universal transport.** Terminal I/O, browser frame streams, agent messages, and control commands all flow over WebSocket connections to the server. The client multiplexes or opens parallel connections per resource.

4. **The Chrome extension is retired as an architecture.** The client is a web page. If someone wants to wrap it in an extension for Side Panel convenience, they can, but the system does not depend on any `chrome.*` APIs.

5. **TODO triage.** Items #8 (offscreen document handoff) and #10 (service worker lifecycle) become low priority — they were solving session persistence in the browser, which the server now owns. Items #5–#7 (CDP commands) move server-side. Item #9b (multi-stream stress test) remains relevant but the relay is now the only path, not an alternative to `chrome.tabCapture`.

6. **Deployment model.** The server runs as a systemd service on any Linux host (a VPS, a cloud VM, a local machine). The client is a static web page served by the same host, accessed over HTTPS. The extension is an optional wrapper that can open the page in a Side Panel.
