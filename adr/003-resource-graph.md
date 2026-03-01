# ADR 003: Resource graph as the universal task model

## Status

Accepted

## Context

The spatial model renders tasks as panes in a 3D grid. Tasks form a tree: a parent decomposes into children, the camera flies through to reveal children, Escape returns to the parent level. This works well for spatial navigation, but the panes themselves are inert — colored rectangles with text labels.

A real agent workspace needs panes that *are* things: a terminal running a build, a browser tab under CDP automation, an LLM conversation, a code editor. The system also spans two platforms: Crush (browser extension, client-side) and AIWM (Linux desktop manager, server-side). A terminal backed by a real PTY lives on a Linux host. A CDP-controlled tab lives in the browser. An LLM conversation is just HTTP, callable from either side.

The tree structure resembles a Unix process tree (`ps --forest`). PID 1 spawns services, services spawn workers. Each node is a resource with a lifecycle — stdin/stdout, memory, a cgroup. The task graph is the same pattern, but heterogeneous: a node might be a terminal, a browser tab, an agent, or a group container.

The question is how to model this so panes can render real content, and so the graph can eventually span platforms without either system knowing the other's internals.

## Decision

Each `TaskNode` gains an optional `resource` field of type `ResourceDescriptor`:

```typescript
type ResourceType = 'terminal' | 'browser' | 'agent' | 'editor' | 'group';

interface ResourceDescriptor {
  type: ResourceType;
  uri: string;  // e.g. wasm://ghostty/term/agent, cdp://local/tab/123, pty://host/session/abc
}
```

The `type` field tells the renderer *how* to display the pane. The `uri` field tells it *where* the backing resource lives. Together they form a locator that decouples the spatial model from the resource lifecycle.

Resource types and their renderers:

| Type | Renderer | Backing |
|---|---|---|
| `terminal` | `TerminalTexture` (Ghostty WASM → Canvas2D → THREE.CanvasTexture) | Local WASM VT, or remote PTY over WebSocket |
| `browser` | Tab capture → texture (future) | CDP via `chrome.debugger` |
| `agent` | Chat UI rendered to texture (future) | LLM API over HTTP |
| `editor` | Code surface rendered to texture (future) | Monaco/CodeMirror in offscreen context |
| `group` | Label-only pane with depth indicator | No resource — container for children |

The URI scheme distinguishes local from remote resources:

- `wasm://ghostty/term/<id>` — Ghostty WASM terminal, fully local
- `pty://<host>:<port>/session/<id>` — remote PTY (AIWM), connected via WebSocket
- `cdp://local/tab/<id>` — browser tab on this Chrome instance
- `llm://<provider>/<model>` — LLM API endpoint

The graph is the protocol. If Crush and AIWM agree on the shape of `TaskNode` and the URI format, they interoperate without knowing each other's internals. Crush renders browser-native resources locally and connects to Linux-side resources over the network. AIWM could do the reverse.

Terminal textures persist across spatial navigation. When the user dives into a child level and returns, the terminal still shows its previous output. The `TerminalTexture` instance lives in a map keyed by task ID, independent of the pane mesh lifecycle.

## Consequences

1. **TaskNode schema** now includes an optional `ResourceDescriptor`. Existing tests pass unchanged — the field is optional and backward-compatible.

2. **TerminalTexture** is the first concrete resource renderer. It owns a Ghostty terminal, an offscreen Canvas2D, and a `THREE.CanvasTexture`. It renders the VT viewport (glyphs, colors, cursor) to the canvas every frame when dirty. The grid scene maps the texture onto the pane's `PlaneGeometry`.

3. **Keyboard routing** changes: when a terminal pane is focused, printable keystrokes go to the terminal, not the grid hotkeys. Grid navigation (Escape, Alt+key) is always available.

4. **The URI scheme is the integration contract.** When AIWM needs to contribute a PTY-backed pane, it publishes a `pty://` URI. Crush creates a WebSocket connection and pipes data between the socket and a `TerminalTexture`. The spatial model doesn't care where the bytes come from.

5. **Schema extraction** into a shared package (`@crush/schema` or similar) should happen when the second consumer (AIWM) actually needs it. Until then, the types live in `src/task-graph.ts`.

6. **Future resource types** (browser, agent, editor) follow the same pattern: a `*Texture` class that renders to a canvas, a URI scheme for the backing resource, and a case in `addPaneForTask` that wires them together.
