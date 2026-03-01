# ADR 007: Agent Runner and Task Decomposition

**Status:** proposed

## Context

Crush is a voice-driven 3D workspace where users direct an LLM agent by speaking. The voice relay (`server/voice-relay.ts`) bridges user speech to Claude with tool use — creating panes, browsing the web, updating notes. To keep voice interaction responsive, the relay's tool-use loop has a hard cap of 5 iterations per turn (`MAX_ITERATIONS = 5`). This ensures the user gets a spoken reply within seconds, not minutes.

The workspace's data model is a `TaskGraph` (`src/task-graph.ts`) that supports hierarchical task decomposition. Each `TaskNode` has a status lifecycle (`pending` → `active` → `complete`), optional `ResourceDescriptor` (with types `terminal`, `pty`, `browser`, `agent`, `editor`, `group`), and parent/child relationships. The graph emits events (`created`, `decomposed`, `activated`, `completed`, `destroyed`) that the client uses to render and animate panes spatially.

The `agent` resource type exists in the type system but has no runtime behind it. It was added anticipating exactly this kind of use.

The problem is research tasks. When a user says "research London tech companies," the voice agent does one Google search, reads one snippet, and replies — because that's all it can do in 5 iterations. Real research requires 30+ rounds of work: formulating sub-queries, opening multiple pages, following links, extracting relevant information, discarding noise, and synthesizing findings into a coherent summary. The voice agent's responsiveness constraint makes it structurally incapable of this depth.

This is not a tuning problem. Making `MAX_ITERATIONS` larger would make the voice agent unresponsive for all interactions, not just research. The constraint exists for good reason. What we need is a way to delegate long-running autonomous work to a separate execution context while the voice agent stays snappy.

## Decision

We introduce an `AgentRunner` class (`server/agent-runner.ts`) that drives autonomous work behind the `agent` resource type. The voice agent gains a `research` tool that delegates to this runner rather than attempting research inline.

The flow works as follows:

1. **The user asks for research.** The voice agent recognizes the request and calls its `research` tool with the query and any parameters.

2. **The voice agent creates a parent task.** A new `TaskNode` is created with resource type `agent` and status `active`. This appears in the workspace as a top-level pane representing the research job.

3. **The parent task is decomposed.** The voice agent (or the runner itself on first activation) calls `TaskGraph.decompose()` to break the research query into sub-tasks — e.g., "Find top London tech companies," "Check recent funding rounds," "Look for coworking hubs." Each sub-task becomes a child `TaskNode`.

4. **The AgentRunner spawns.** A new `AgentRunner` instance is created server-side with:
   - Its own LLM conversation history, separate from the voice agent's
   - A research-focused system prompt emphasizing thoroughness, source diversity, and structured output
   - A high iteration limit (50) appropriate for deep multi-step work
   - Access to the same tool infrastructure (`browse`, `create_pane`, `update_text_pane`) via the same WebSocket connection
   - A reference to the parent task ID for progress reporting

5. **The runner works autonomously in the background.** It iterates through sub-tasks, opening browser panes for each search, following links, extracting information. Each sub-task gets its own browser pane so the user can watch the research happening spatially in the workspace. The voice agent returns immediately with a short acknowledgment ("I've started researching London tech companies — you'll see the results appear").

6. **A notes pane accumulates findings.** The runner creates a text pane (resource type `editor`) as a sibling or child of the parent task. As it completes each sub-task, it appends structured findings to this pane via `update_text_pane`. The user sees the research document growing in real time.

7. **Progress is visible through the task graph.** Sub-tasks transition through `pending` → `active` → `complete` as the runner works. The client renders these status changes, giving the user a live progress view without any polling or special UI.

8. **The voice agent can interact with the running research.** Since the research state lives in the `TaskGraph`, the voice agent can answer questions like "how's the research going?" by inspecting task statuses. It can also interrupt or redirect: destroying the parent task cascades to children (via `TaskGraph.destroy()`'s recursive behavior), stopping the runner.

The `AgentRunner` class is intentionally generic. It takes a system prompt, iteration limit, tool set, and parent task ID. Research is the first use case, but the same class can drive code generation, data analysis, or any multi-step autonomous workflow. The `research` tool on the voice agent is a thin wrapper that configures an `AgentRunner` with research-specific parameters.

Communication between the runner and the client uses the existing WebSocket command protocol. The runner emits `command` messages (`create_pane`, `update_text_pane`, task status changes) on the same WebSocket connection the voice agent uses. No new protocol is needed.

## Consequences

**Voice latency is preserved.** The voice agent's 5-iteration limit is unchanged. Delegating to the runner is a single tool call — the agent says "on it" and returns. The user can keep talking, ask other questions, or request other panes while research runs.

**Research quality improves dramatically.** With 50 iterations, the runner can open 10+ pages, cross-reference sources, and build a structured summary. This is the difference between a single search snippet and a genuine research brief.

**The `agent` resource type gets a real runtime.** The type has existed in `TaskGraph` since the resource descriptor system was built. Now it maps to a concrete server-side process. This validates the original type system design.

**The pattern is reusable.** `AgentRunner` is not research-specific. Future tools on the voice agent — `implement`, `analyze`, `draft` — can each spawn runners with different system prompts and tool sets. The voice agent becomes a dispatcher for autonomous workers, not a bottleneck that must do everything itself.

**Spatial visibility comes for free.** Because the runner creates real panes (browser tabs, text panes) and real task graph nodes, the user sees autonomous work happening in the 3D workspace. No special "agent progress" UI is needed — it's just panes appearing, loading, and completing.

**Cost and runaway risk exist but are bounded.** Each runner iteration is an LLM call. At 50 iterations maximum, a single research task could cost a few dollars in API usage. The hard cap prevents infinite loops. The user can interrupt at any time by voice ("stop the research"), which triggers task destruction and runner shutdown. We may add a token budget or wall-clock timeout in the future, but the iteration cap is sufficient for the initial implementation.

**Concurrency is simple initially.** The first implementation runs one `AgentRunner` at a time per WebSocket connection. Multiple concurrent runners would require managing shared browser resources and WebSocket message interleaving, which we defer until the single-runner pattern is validated.
