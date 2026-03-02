# crush

A voice-driven spatial workspace where AI agents do the work and the user directs.

## What

You talk to it. It does things. Results appear in a 3D spatial scene — clustered, organized, navigable. No keyboard, no mouse, no clicking through menus. See `VISION.md` for the design philosophy.

## Architecture

Server-authoritative (see ADR 004). The browser is a thin rendering client.

| Concern | Where |
|---|---|
| Agent runtime, LLM calls, tool execution | Server (Node.js on Linux host) |
| PTY sessions (real shell) | Server (`server/pty-relay.ts`) |
| Browser automation (CDP) | Server (`server/cdp-relay.ts`, `agent-browser` CLI) |
| Voice pipeline | Server voice relay + client STT/TTS (ADR 005, 006) |
| Autonomous background work | Server (`server/agent-runner.ts`) |
| 3D rendering (Three.js/WebGPU) | Client (browser) |
| Voice capture, STT, TTS | Client |
| Spatial scene, pane textures | Client (`src/grid-scene.ts`, `src/pane.ts`) |

## Key abstractions

- **`TaskGraph`** (`src/task-graph.ts`) — Tree of `TaskNode`s with status lifecycle (pending→active→complete), optional `ResourceDescriptor`, parent/child decomposition. Events drive the scene.
- **`Pane`** hierarchy (`src/pane.ts`) — `PtyPane` (remote shell), `BrowserPane` (CDP screencast), `TextPane` (markdown/text), `TerminalPane` (local Ghostty WASM), `PlainPane` (solid color). Each wraps a Three.js mesh + texture.
- **`AgentRunner`** (`server/agent-runner.ts`) — Autonomous background worker. Decomposes goals into parallel sub-queries, each with its own LLM conversation + browser session.
- **`VoiceClient`** (`src/voice-client.ts`) → **`voice-relay`** (`server/voice-relay.ts`) — Speech→Claude→tools→speech. The voice relay dispatches to tools, creates panes, kicks off AgentRunners.
- **`grid-scene`** (`src/grid-scene.ts`) — The 3D spatial scene. Responds to TaskGraph events, manages camera, atmosphere, pane layout.

## Running

```bash
npm install
npm run dev          # Vite dev server (client)
# Server components run separately — see server/*.ts
```

## Docs

- `VISION.md` — Design philosophy, neuroscience-grounded spatial principles
- `adr/` — Architecture decision records
- `LAB.md` — Proven capabilities, walls, open questions
- `AGENTS.md` — Agent/contributor conventions
