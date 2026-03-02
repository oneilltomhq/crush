# ADR 008: Embed Pi Agent Core to Replace Hand-Rolled Agent Plumbing

**Status:** accepted

## Context

Crush's server-side agent code (`agent-server.ts` + `agent-runner.ts`, 1,367 lines total) hand-rolls the entire LLM interaction stack:

- **Raw HTTP fetch to Anthropic API** — manual JSON body construction, header management, error parsing.
- **Tool dispatch** — a giant `switch/case` in `executeTool()` mapping tool names to implementations.
- **Conversation history** — a plain `ConversationMessage[]` array, manually trimmed at 30 entries with `slice(-30)`.
- **Tool-use loop** — a `while` loop that calls the LLM, checks `stop_reason`, executes tools, pushes `tool_result` messages, and repeats.
- **Type definitions** — `ContentBlock`, `ApiResponse`, `ConversationMessage` re-declared locally.

The `AgentRunner` (research pipeline) duplicates most of this: its own `callLLM()`, its own `ContentBlock`/`ApiResponse` types, its own tool dispatch, its own conversation history management. The two files share zero code despite doing nearly the same thing.

Meanwhile, the Pi framework (`@mariozechner/pi-agent-core`) provides exactly this plumbing as a tested, maintained library:

- **`Agent` class** — stateful agent with tool execution loop, event streaming, abort support.
- **`AgentTool` interface** — typed tool definitions with `execute()` returning `AgentToolResult`.
- **Multi-model support** — `Model` objects with provider/cost/context metadata; swap models per-call.
- **Event system** — `agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/end`.
- **Steering & follow-up** — inject messages mid-run or queue them for after completion.
- **`pi-ai` layer** — provider-agnostic streaming for Anthropic, OpenAI, Google, OpenRouter, and 15+ more.

Pi is already installed on this machine (v0.55.1, used by OpenClaw). OpenClaw's integration pattern (`createAgentSession()` with custom tools) demonstrates that Pi is designed for exactly this embedding use case.

The current code is also locked to a single model (Claude Sonnet 4) with no ability to use cheaper models for sub-tasks. Research runs cost ~$1.20/report because every LLM call — including the planning step and 6 parallel sub-runners — uses the same expensive model.

## Decision

We replace the hand-rolled agent plumbing in both `agent-server.ts` and `agent-runner.ts` with `pi-agent-core`'s `Agent` class and `pi-ai`'s model/streaming layer.

### What changes

1. **Agent loop**: Delete both `callLLM()` functions, the `while` tool-use loops, and the manual `tool_result` message construction. Replace with `Agent.prompt()` which handles the full loop internally.

2. **Tool definitions**: Convert the `TOOLS` array and `executeTool()` switch/case into `AgentTool` objects. Each tool becomes a self-contained object with `name`, `description`, `parameters` (TypeBox schema), and `execute()` method.

3. **Model objects**: Define `Model` objects for the exe-gateway Anthropic endpoint. The voice agent uses Sonnet for responsiveness; the research runner can use the same or a different model. The model is a plain object conforming to `Model<Api>` — no registry needed.

4. **Event-driven progress**: Subscribe to `Agent` events for research progress instead of manual `console.log` calls. The voice agent uses events to stream partial responses.

5. **Conversation history**: Managed by `Agent.state.messages` instead of a manual array. Context window management can later use Pi's compaction utilities.

### What stays the same

- **WebSocket protocol** — the client-facing `{ type, text }` JSON frames are unchanged.
- **Tool implementations** — the actual logic (shell execution, Tavily search, agent-browser CDP) is unchanged.
- **Architecture** — voice agent + background research runner pattern (ADR 007) is preserved.
- **No session persistence** — we use `Agent` directly, not `AgentSession`/`SessionManager`. Crush conversations are ephemeral (voice-driven, not chat-based). Persistence can be added later if needed.
- **No coding tools** — we don't use Pi's built-in `read/write/edit/bash` tools. Our tools are workspace-specific (create_pane, browse, research, etc.).

### Multi-model routing (future-ready)

The refactored code constructs `Model` objects explicitly. This means we can trivially:
- Use Sonnet 4 for the voice agent (fast, good at short responses)
- Use a cheaper model for research sub-runners (the bulk of token spend)
- Swap models at runtime via `agent.setModel()`

We don't implement multi-model routing in this ADR — that's a separate configuration concern. But the refactoring removes the structural blocker (hardcoded model + raw fetch) that currently prevents it.

### Integration approach

We use `pi-agent-core` and `pi-ai` directly, **not** `pi-coding-agent`. The higher-level package brings session management, file tools, CLI integration, and extension loading — none of which we need. The two lower packages give us:

- `pi-ai`: `Model` type, `registerBuiltInApiProviders()`, `streamSimple()`
- `pi-agent-core`: `Agent` class, `AgentTool` type, `AgentEvent` type

We import from the installed OpenClaw node_modules (already on disk) rather than adding new dependencies, since the packages are already available. If we later want to decouple from OpenClaw's install, we add them to crush's package.json.

## Consequences

**~800 lines of plumbing deleted.** Both `callLLM()` functions, both sets of type definitions, the tool-use while loops, the manual history management, and the duplicated Tavily/CDP helper code.

**Tools become self-contained.** Each tool is a module-level `AgentTool` object with its own execute function. Adding a new tool means adding one object — no switch/case to update.

**Multi-model routing becomes trivial.** `agent.setModel()` before `agent.prompt()` is all it takes. The voice agent and each research sub-runner can use different models.

**Event-driven architecture.** Agent events (`turn_end`, `tool_execution_end`) replace the current ad-hoc logging. The WebSocket bridge subscribes to events and translates them to client messages.

**Dependency on Pi packages.** We depend on `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`. These are actively maintained (v0.55.1) and already installed. The dependency is lightweight — pi-agent-core is ~2K lines.

**No breaking changes to the client.** The WebSocket protocol is unchanged. The client doesn't know or care that the server switched from raw fetch to Pi.

**Research pipeline preserved.** The plan→parallel-execute→synthesize pattern from ADR 007 is unchanged. Each sub-runner gets its own `Agent` instance with its own conversation history, just as before — but now managed by Pi instead of manual arrays.
