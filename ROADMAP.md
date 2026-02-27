# crush — roadmap

> Goal: presentable prototype / demo. Not production. Optimise for "someone sees this and is impressed."

---

## M0 — Anti-flake harness

- [x] Vitest setup
- [x] Test `StdinStream`
- [x] Test `CrushAuthStorage`
- [x] Test `MemoryWorkspaceFS`
- [x] Test `LocalShell`
- [x] CI — GitHub Actions
- [x] Wire `AbortController` into `ProgramContext`

## M1 — Browser control wired

- [x] Service worker RPC
- [x] `attach` / `detach` commands
- [x] `navigate <url>` command
- [x] `click <selector>` command
- [x] `type <text>` command
- [x] `screenshot` command
- [x] `evaluate <js>` command
- [x] Screenshot → 3D texture

## M2 — Agent loop

- [x] `agent <goal>` command
- [x] Tool definitions
- [x] Bounded autonomy
- [x] Screenshot refresh
- [x] Narration
- [x] Ctrl+C interruption
- [x] Anthropic API integration

## M3 — Integration & Polish

- [x] Spike cleanup
- [x] Wire `chrome` context
- [x] Welcome message
- [x] `ls` command enhancement
- [x] Command not found enhancement

## M4 — Filesystem Polish & Test

- [x] Test filesystem commands
- [x] Implement `cwd`
- [x] Implement `cd` and `pwd`
- [x] Update prompt

## M5 — Agent & Rendering Polish

- [x] Test CDP commands
- [x] Hide cursor while typing
- [x] Wire `scene` context

## M6 — Hardening & Refinement

- [x] Filesystem `stat` method: Add a `stat` method to `WorkspaceFS` to check for file/dir existence and type, and update `cd` to use it.
- [x] More CDP command tests: Add tests for `type`, `scroll`, `hover`, and `select`.
- [ ] `check` and `uncheck` commands: Implement browser control commands for checkboxes and radio buttons.

---

## Parked

| Item | Why parked | Revisit when |
|---|---|---|
| `src/` reorg | Premature for demo | File count doubles |
| Offscreen document handoff | Real user value, not demo value | Agent needs to survive panel close |
| Tab capture streaming | Single-frame screenshots are enough | Need smooth live-tab-in-3D at 30+ fps |
| OffscreenCanvas + Worker WebGPU | Optimisation | Rendering becomes the bottleneck |
| Full CDP parity | Core commands are enough for demo | Agent fails on real tasks |
| Real PTY / shell connection | Project is browser-native by design | Never (design decision) |
| SW lifecycle investigation | Dissolves if SW stays a thin RPC relay | SW becomes stateful or flaky |
