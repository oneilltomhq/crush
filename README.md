# crush

An AI agent runtime that turns voice into action — agents search the web, drive browsers, run shell commands, and manage multi-step workflows while the user directs from a spatial 3D workspace.

## What it does

You talk to it. It dispatches specialized agents that do real work: prospecting on LinkedIn, searching job boards, scraping conference sites, building resumes, automating browser sessions. Results appear in a 3D spatial scene — clustered, organized, navigable.

## Architecture

Server-authoritative multi-agent system. The browser is a thin rendering client.

| Layer | What | Where |
|---|---|---|
| **FOH agent** | Voice interface, task routing, delegation | `server/agent-server.ts` |
| **Worker agents** | Shell, browser, prospecting, LinkedIn, profiling | `agents/*.md` + `server/worker-agent.ts` |
| **Skills** | Domain knowledge with progressive disclosure | `skills/*/SKILL.md` |
| **CLI runner** | Invoke any agent headlessly | `server/run-agent.ts` |
| **Tool layer** | Web search, CDP browser automation, shell, filesystem | `server/pi-tools.ts` |
| **3D renderer** | WebGPU/Three.js spatial scene, SDF text, pane system | `src/` |
| **Voice pipeline** | Client-side STT/TTS + server relay | ADR 005, 006 |

### Agent system

Agent definitions live in `agents/` as markdown files with YAML frontmatter (ADR 012). Each specifies a model, tools, skills, and persona. Skills (ADR 013) follow the [Agent Skills standard](https://agentskills.io) — `SKILL.md` files with `references/` directories for deeper context, loaded on-demand.

The FOH agent delegates to typed workers (shell, browser, prospector, linkedin-prospector, linkedin-profiler). Workers load their referenced skills at dispatch time and use `read_file` to drill into skill references as needed.

```bash
# Run any agent from the command line
npx tsx server/run-agent.ts prospector "Find agentic AI contracts in London, posted last 30 days"
npx tsx server/run-agent.ts shell "Update the README and commit"
```

### Key abstractions

- **`AgentRunner`** — Autonomous background worker. Decomposes goals into parallel sub-queries, each with its own LLM conversation.
- **`Pane`** hierarchy — `PtyPane` (remote shell), `BrowserPane` (CDP screencast), `TextPane` (markdown), `TerminalPane` (Ghostty WASM). Each wraps a Three.js mesh + texture.
- **`TaskGraph`** — Tree of `TaskNode`s with status lifecycle, driving the spatial scene.
- **`grid-scene`** — The 3D spatial scene. WebGPU rendering, SDF text at 60fps, atmospheric effects.

## Running

```bash
npm install
npm run dev          # Vite dev server (client)
# Server: npx tsx server/agent-server.ts
# CLI: npx tsx server/run-agent.ts <agent> "<goal>"
```

## Docs

- `adr/` — Architecture decision records (13 and counting)
- `agents/` — Agent definitions
- `skills/` — Domain knowledge skills
- `VISION.md` — Design philosophy
- `AGENTS.md` — Contributor conventions
