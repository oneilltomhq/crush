# crush — roadmap

> Goal: presentable prototype / demo. Not production. Optimise for "someone sees this and is impressed."

---

## M0 — Anti-flake harness

Tests + CI so the demo doesn't break while we build it. One day, not a quality crusade.

- [x] Vitest setup — install, configure, one passing test to prove the pipeline
- [x] Test `StdinStream` — queued push before `next()`, `close()` unblocks pending `next()`, push-after-close ignored
- [x] Test `CrushAuthStorage` — key prefixing, get/set/delete via `MemoryStorageBackend`
- [x] Test `MemoryWorkspaceFS` — path normalisation, `..` traversal rejection, basic CRUD
- [x] Test `LocalShell` — command dispatch with args, unknown command error, foreground program captures input then returns control to shell
- [x] CI — GitHub Actions: `tsc --noEmit` + `vitest run`. Lint later.
- [x] Wire `AbortController` into `ProgramContext` so foreground programs (especially the future agent) can be interrupted via Ctrl+C

## M1 — Browser control wired

CDP commands exposed as shell commands + a screenshot rendered as a texture in the 3D scene. This is the unique value prop becoming visible.

- [ ] Service worker RPC — side panel can call `chrome.debugger` methods via message passing to the SW
- [ ] `attach` / `detach` commands — handle `onDetach` cleanly (DevTools opened, tab closed/crashed)
- [ ] `navigate <url>` command — `Page.navigate` + wait for `Page.loadEventFired`
- [ ] `click <selector>` command — resolve selector via `Runtime.evaluate`, get bounding box, `Input.dispatchMouseEvent`
- [ ] `type <text>` command — `Input.insertText` (raw text), `Input.dispatchKeyEvent` for Enter/Tab
- [ ] `screenshot` command — `Page.captureScreenshot`, display as base64 in terminal or write to OPFS
- [ ] `evaluate <js>` command — `Runtime.evaluate`, print result
- [ ] Screenshot → 3D texture — render `Page.captureScreenshot` result onto a Three.js plane in the scene (single frame per action, not live streaming)

## M2 — Agent loop

An `agent` command that runs a bounded LLM tool-use loop, narrating what it does in the terminal.

- [ ] `agent <goal>` command — accepts a natural-language goal, starts an LLM conversation
- [ ] Tool definitions — expose M1 CDP commands as tool schemas the LLM can call
- [ ] Bounded autonomy — hard cap (~10 tool calls), visible step counter ("Step 3/10: clicking Sign in")
- [ ] Screenshot refresh — update the 3D texture after each action (or every 2–3 steps)
- [ ] Narration — print what the agent is doing and a summary when it finishes
- [ ] Ctrl+C interruption — abort the agent loop cleanly via the `AbortController` from M0
- [ ] Anthropic API integration — direct fetch from side panel (host permission already in manifest)

---

## Parked

Things we've investigated and decided not to do yet. Not lost, just not demo-relevant.

| Item | Why parked | Revisit when |
|---|---|---|
| `src/` reorg (core/platform/ui layers) | Premature for demo; flat layout is fine at current file count | File count doubles or cross-context imports cause bugs |
| Offscreen document handoff (#8) | Real user value, not demo value | Agent needs to survive panel close |
| Tab capture streaming (#9) | Single-frame screenshots are enough; live streaming is a perf risk | Need smooth live-tab-in-3D at 30+ fps |
| OffscreenCanvas + Worker WebGPU (#3) | Optimisation | Rendering becomes the bottleneck |
| Full CDP parity (scroll, hover, select, drag) | Core 5–6 commands are enough for the demo | Agent fails on real tasks due to missing actions |
| Real PTY / shell connection | Project is browser-native by design — no localhost or remote shell | Never (design decision) |
| SW lifecycle investigation (#10) | Dissolves if SW stays a thin RPC relay | SW becomes stateful or flaky |
