# crush

A browser-native agent shell, by extension.

## Why

- The browser is already a sandbox with a permission model — agents get power tools without root access
- Every end user already has one — no sysadmin, no daemon, just install the extension
- Agents inherit what the user already has: cookies, auth state, extensions

## What

**Shell layer** — A Manifest V3 Chrome extension exposing the browser's power tools to LLM agents:
- `chrome.debugger` / CDP for tab automation (navigate, click, type, snapshot, screenshot)
- Side Panel API for persistent chat UI and agent runtime
- Local shell with line editing, program model, and built-in commands (`help`, `echo`, `clear`, `colors`, `date`)
- Storage backend (`chrome.storage.local`) for API keys and settings
- OPFS-based virtual filesystem for workspace files

**Rendering layer** — A 3D terminal rendered in the side panel:
- Three.js WebGPU renderer with SDF text via [Three.js Blocks](https://github.com/nicokoenig/threejs-blocks) `BatchedText`
- Ghostty VT core compiled to WASM (via [coder/ghostty-web](https://github.com/coder/ghostty-web)) — full terminal emulation driving the renderer
- 80×24 grid of individually colored glyphs in a single draw call, with cursor blinking
- Keyboard input translated to terminal escape sequences via `KeyEncoder`

## Status

Working end-to-end: the side panel boots a WebGPU renderer backed by Ghostty's WASM VT emulator, with a local shell accepting commands. No PTY backend yet — connect a WebSocket server for a real shell.

Active areas: PTY relay, CDP browser panes, task-graph-driven workspace. See `adr/` for architectural direction.

## Architecture

| Concern | Owner |
|---|---|
| Agent loop + rendering | Side panel |
| Privileged APIs (CDP, tabs) | Service worker (thin RPC bridge) |
| Terminal emulation | Ghostty WASM (`GhosttyTerminal`) |
| Keyboard encoding | `KeyEncoder` (ghostty-web) |
| Persistent state | `chrome.storage.local` / OPFS |

See `adr/` for architecture decision records, `LAB.md` for confirmed capabilities and open questions.

## Getting started

```bash
npm install
npm run build
```

Then load the extension in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the project root (the directory containing `manifest.json`)
4. Click the Crush extension icon to open the side panel

For development with hot reload:

```bash
npm run dev
```

## Tech

TypeScript · Three.js · WebGPU · SDF text · libghostty-vt (WASM) · Chrome Extension (MV3) · Side Panel API · Chrome DevTools Protocol
