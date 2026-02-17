# crush

Agentic chromium shell — a Chrome extension that acts as an agentic interface to the browser's power tools (debugger, side panel, screen capture), with a 3D multiplexed terminal UI built on Three.js WebGPU, SDF text rendering, and libghostty-vt.

## Why

The browser is a zero-setup sandbox. Every end user already has one — no sysadmin or dev experience required, just install the extension. **crush** turns that sandbox into a programmable shell where LLM agents can see, navigate, and operate the browser on the user's behalf, inheriting their existing cookies, auth state, and extensions.

## What

**Shell layer** — A Manifest V3 Chrome extension exposing the browser's power tools to LLM agents:
- `chrome.debugger` / CDP for tab automation (navigate, click, type, snapshot, screenshot)
- Side Panel API for persistent chat UI
- Screen capture and tab management
- Accessibility tree + DOMSnapshot ref system for element targeting

**Rendering layer** — A 3D multiplexed terminal experience:
- Three.js WebGPU renderer with TSL shader blocks
- SDF text rendering (inspired by [Three.js Blocks](https://github.com/nicokoenig/threejs-blocks))
- libghostty-vt compiled to WASM for in-browser terminal emulation
- Tabs rendered as 3D terminal panes in an orchestration window

## Status

Early exploration — discovering how the shell and rendering layers connect through empirical Q&A. Current questions:
- Can we render live tab content as Three.js textures/portals in a single orchestration pane?
- What does a multiplexed terminal UX look like when the "terminals" are browser tabs driven by agents?
- How far can libghostty-vt go in the browser via WASM?

## Tech

TypeScript · Three.js · WebGPU · TSL · libghostty-vt · Chrome Extension · Manifest V3 · Side Panel API · Chrome DevTools Protocol · LLM Agents
