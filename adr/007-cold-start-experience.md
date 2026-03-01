# ADR 007: Cold start experience

## Status

Proposed

## Context

Crush is a server-authoritative spatial workspace (ADR 004). The client is a web page served by the Crush server. The Chrome extension is retired.

Today's cold start is broken in two different ways:

1. **`grid.html`** (the real client): immediately tries to connect three WebSocket endpoints (PTY at `/ws/pty`, CDP relay at `/ws/cdp`, voice at `/ws/voice`). If the server isn't running, the PTY pane renders nothing, the voice connection dot stays red, the transcript pane says "(listening...)". API keys for Deepgram and ElevenLabs are hardcoded or passed as URL params. There is no onboarding, no error recovery, no guidance.

2. **`sidepanel.html`** (vestigial extension entry point): boots a WebGPU terminal with five toy commands. Says "Connect a WebSocket PTY server for a real shell." This is a rendering proof-of-concept that shouldn't be an entry point anymore.

Both paths assume a developer who already understands the architecture and has all infrastructure running.

Several design questions:

**What does the user see before the server connects?** Today: a blank or broken scene. WebGPU initializes, Three.js loads, Ghostty WASM compiles — all before any content appears. On a slow machine, several seconds of black screen.

**What happens when the server is down?** Silent failure. WebSocket `onclose` triggers a 3-second reconnect. The user sees a red dot and nothing else. No explanation, no diagnostics, no way to configure the server URL.

**What about credentials?** Voice requires Deepgram + ElevenLabs API keys. The server needs an LLM endpoint (currently hardcoded to the exe.dev metadata service). These are scattered across URL params, hardcoded constants, and server environment variables. No unified configuration surface.

**What does "working" look like?** A successful cold start should end with the user able to do something real — talk to the workspace, see a shell, browse a page. How many steps should that take?

## Decision

The cold start has three progressive stages: **render**, **connect**, **converse**. Each stage is independently useful and fails gracefully into the previous stage.

### Stage 1: Render (0 dependencies)

The client loads and shows a scene immediately. No server required. No API keys required.

- WebGPU initializes, the dark background appears, the camera is positioned.
- A single centered text pane displays a connection status message. Not a terminal — just styled text rendered via `TextTexture`:

  ```
  crush

  connecting to server...
  ```

- If WebGPU is unavailable, fall back to a plain DOM message explaining the requirement. Don't render a broken canvas.
- WASM binary and font atlas load in parallel. Needed for Stage 2 but don't block Stage 1.

This stage is a loading screen, but it's the real renderer doing real work — not a fake splash. It proves the GPU pipeline works.

### Stage 2: Connect (server required)

The client opens a WebSocket to the Crush server. The server URL comes from:

1. `?server=wss://...` URL parameter (explicit override)
2. Same-origin WebSocket (default — `wss://${location.host}/ws`)

No other configuration is needed. The server manages its own LLM credentials, PTY sessions, and CDP connections.

Connection states, shown on the status pane:

- **Connecting**: `connecting to server...` (subtle animation — ellipsis cycling)
- **Connected**: status pane dissolves, workspace panes appear (Shell, Todo, Transcript per the current `onInit` flow)
- **Failed**: `couldn't reach server at wss://...` with a retry countdown. After repeated failures: `server unreachable — check that crush-server is running`
- **Disconnected mid-session**: panes stay visible (rendered from local state), a reconnection banner appears. On reconnect, the server replays current state.

The server sends an `init` message with workspace state (existing panes, todo content, available voice credentials). The client builds its scene entirely from this message.

### Stage 3: Converse (mic + STT/TTS keys required)

Voice activation is separate from server connection. The client can be fully connected and show a working workspace without voice.

When the user taps the canvas (per ADR 006), the voice pipeline activates:

1. **Microphone permission**: browser prompt fires. If denied: `mic access needed for voice — tap to try again` in the status area. The workspace remains visible.

2. **STT connection**: Deepgram WebSocket opens. If the API key is missing or invalid: `voice unavailable — STT not configured`. The key comes from the server's `init` message (the server holds all credentials).

3. **TTS**: ElevenLabs fetch. If the key is missing, voice still works for input — the agent responds in text via the transcript pane, just without audio. Degraded but functional.

Voice failures never block workspace use. The workspace is the product; voice is the interaction modality.

### Configuration surface

All configuration flows through the server. The client has exactly one config: the server URL (defaulting to same-origin). Everything else — LLM endpoint, API keys, workspace state, PTY settings — lives server-side and arrives via the `init` message.

If we need a settings UI (e.g., for API key entry when not using the metadata service), it's a voice-invocable command ("show settings") that opens a settings pane in the workspace, not a separate page.

### Entry point consolidation

`grid.html` / `grid-scene.ts` is the single entry point. The Crush server serves it as a static page. `sidepanel.html` and `sidepanel.ts` are retired — they were proof-of-concept for the rendering stack, and that proof is complete. `manifest.json` and `background.ts` are retired per ADR 004.

The `LocalShell` code and `CrushProgram` interface stay in the codebase for potential future use (WASM-local fallback shell), but they are not on the cold start path.

## Consequences

1. **The client gets a connection state machine.** Today `grid-scene.ts` fires and forgets three WebSocket connections. It needs a unified connection manager that tracks state (`disconnected → connecting → connected → reconnecting`) and drives the status UI. The voice client already has a partial version; it needs to be generalized.

2. **The server gets a proper `init` protocol.** Today `init` sends `{ type: 'init', todo: string }`. It needs to send full workspace state: existing panes (type, label, resource URI), available credentials (which voice services are configured, keys the client needs for direct STT/TTS connections), user preferences. The client builds its scene entirely from this message.

3. **API keys move server-side.** The hardcoded Deepgram and ElevenLabs keys in `grid-scene.ts` are removed. The server sends them in `init`. Given ADR 005's decision for client-side STT/TTS (latency), the server providing keys at init time is the right path.

4. **WebGPU fallback becomes a real requirement.** If Stage 1 can't render, the user sees nothing. We need a DOM fallback — a styled `<div>` that says "WebGPU not supported" with browser upgrade instructions. Not a full fallback renderer; an error page.

5. **Extension artifacts are cleaned up.** `manifest.json`, `background.ts`, `sidepanel.html`, `sidepanel.ts`, and `chrome.storage` / OPFS code become dead. They should be removed or moved to an `archive/` directory.

6. **The first impression changes.** From "broken terminal with five commands" to "workspace connecting to your server." This honestly represents what Crush is: a viewport into a server-side agent runtime.

7. **Offline mode is explicitly deferred.** A user who opens the page without a server sees a connection screen, not a toy shell. This is honest. If local-only mode matters later, it's a Stage 2 fallback — not the default.
