# crush — roadmap

## Where we are

Server-authoritative architecture is in place. Voice-driven 3D workspace works end-to-end: user speaks → Claude processes with tools → panes appear/update in the Three.js scene. AgentRunner can decompose research tasks into parallel sub-queries. PTY relay provides real shell access. CDP relay streams browser content.

The 3D scene is a flat grid of panes with depth-based drill-down. Voice is the only input modality.

## What’s next

**Authenticated browser automation** — The agent needs to act in the user’s authenticated browser context (LinkedIn, X, Gmail, etc.). The server’s browser has no sessions. Working. User’s real browser (Brave/Chrome with `--remote-debugging-port=9222`) is tunneled to the server via SSH reverse tunnel (`ssh -R 9223:localhost:9222`). Patchright connects at `http://localhost:9223` for undetectable automation with human-behavior simulation and auto-CAPTCHA solving. See `OPS.md` for setup.

**Spatial clustering** — Move from flat pane grid to neuroscience-grounded spatial arrangement: chunking (3–5 clusters), stable positions for spatial memory, peripheral attention via motion/glow. See `VISION.md`.

**Invisible agents, visible results** — Agent work (browsing, clicking, searching) should be invisible. The user sees synthesized results materializing as spatial clusters, not raw browser tabs.

## Parked

| Item | Why | Revisit when |
|---|---|---|
| Chrome extension as full architecture | Superseded by server-authoritative (ADR 004) | Never |
| Offscreen document handoff | Server owns persistence now | N/A |
| Tab capture streaming | Single-frame screenshots sufficient | Need smooth live-tab-in-3D |
| OffscreenCanvas + Worker WebGPU | Premature optimization | Rendering bottleneck |
