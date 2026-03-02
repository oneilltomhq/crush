# ADR 009: Front-of-House / Worker Agent Separation

**Status:** accepted

## Context

The current agent-server uses a single Pi agent-core Agent instance per connection. This agent handles both conversation (voice I/O) and task execution (tool calls). The `processText` function awaits the full agent loop — including multi-step tool chains — before sending any response to the user.

This creates three problems:

1. **Latency.** When the agent decides to call tools, the user hears nothing until the entire tool chain completes. A browse→search→synthesize chain can take 10-30 seconds. Voice UX requires sub-second first-response.

2. **Blocking.** The `processing` flag rejects new user messages while tools are running. The user cannot steer, interrupt, or ask questions mid-execution. Pi's `steer()` mechanism exists but can't fire because user input is dropped at the gate.

3. **Model mismatch.** Conversation needs speed (fast TTFT, short outputs). Task execution needs capability (reasoning, long context, tool use). A single model can't optimize for both. Sonnet 4 is a reasonable middle ground but ideal for neither role.

We partially solved this for research: `AgentRunner` is a fire-and-forget background agent with progress callbacks. But all other tools (shell, browse, auth_browse, file I/O, pane management) still run inline in the voice agent's blocking loop.

## Decision

Separate the system into a **front-of-house (FOH) agent** and **worker agents**.

### Front-of-house agent

- **Role:** Conversational interface. Receives user speech, responds immediately, delegates work.
- **Model:** Fastest available inference. Groq (Llama 4 Scout) for ~100ms TTFT, or the smallest Anthropic model that can handle routing. Must be under 500ms to first spoken word.
- **Tools (thin):** `delegate_task`, `check_tasks`, `manage_panes`, `read_file`, `write_file`. No heavy tools — it never runs shell commands, browses pages, or calls external APIs directly.
- **Behavior:** Never blocks for more than ~1 second. If something will take time, it tells the user what's happening and hands off to a worker. It monitors worker events and proactively reports progress.
- **State:** Maintains conversation history. Has access to user profile and task graph. Does NOT hold tool execution state.

### Worker agents

- **Role:** Execute specific tasks in the background. Each worker is an independent Agent instance with its own model, tools, and conversation.
- **Types:**
  - **Research worker** — already exists as `AgentRunner`. Uses MiniMax M2.5.
  - **Shell/coding worker** — runs shell commands, reads/writes files, does git operations. Needs a capable model (Sonnet 4 or better).
  - **Browser worker** — drives CDP automation (browse, auth_browse). Needs a model good at structured interaction.
  - **Generic task worker** — catch-all for file processing, drafting, analysis.
- **Lifecycle:** Created by FOH agent via `delegate_task`. Run in background. Emit progress events. Complete with a result or error.
- **Model:** Each worker type can use a different model optimized for its domain.

### Communication

```
User (voice) ←→ FOH Agent ←→ Worker Agents
                    ↕              ↕
               Pane System    Tool Execution
```

The FOH agent subscribes to worker events (progress, completion, error, needs-approval). When a worker needs user input (confirmation gate), the FOH agent presents the question and relays the answer via the worker's `steer()` method.

### Implementation path

**Phase 1 — Generalize AgentRunner into WorkerAgent.** The research runner already has the right shape: background execution, progress callbacks, WebSocket updates. Extract the pattern into a generic `WorkerAgent` class that accepts a task description, model, and tool set. Research becomes one specialization.

**Phase 2 — Slim down the FOH agent.** Remove heavy tools from the voice agent. Replace them with `delegate_task` (creates a WorkerAgent) and `check_tasks` (reads worker status). Keep `read_file`, `write_file`, and `manage_panes` since they're instant. The FOH agent's system prompt becomes pure conversational routing.

**Phase 3 — Switch FOH to a fast model.** Once the FOH agent only needs to route and converse, swap it to Groq or a small Anthropic model. This is where the latency win materializes.

**Phase 4 — Worker event stream.** FOH agent subscribes to a worker event bus. Instead of polling with `check_tasks`, workers push events that the FOH agent can proactively surface to the user: "Your LinkedIn review is done, want to see it?" or "The research agent found 12 opportunities, still filtering."

## Consequences

**Positive:**
- Voice latency drops to sub-500ms regardless of task complexity.
- User can talk to the system while workers are busy — no more `Still processing previous request`.
- Each worker uses the optimal model for its domain (fast/cheap for simple tasks, capable for complex ones).
- Workers are independently testable — same as AgentRunner already is.
- Natural fit for the task/pane management story: each worker owns a pane.

**Negative:**
- More moving parts. FOH agent needs to be smart enough to route tasks well despite being a smaller model.
- State coordination: workers need to share context (user profile, workspace state) without duplicating it.
- Confirmation flow is more complex: worker pauses → signals FOH → FOH asks user → user responds → FOH steers worker.
- Risk of over-engineering: we could ship incremental improvements to the current architecture (streaming responses, concurrent tool calls) that solve 80% of the latency problem without the full separation.

**Open questions:**
- ~~Can Groq's Llama 4 models handle the routing/conversation role well enough? Need to eval.~~ **Confirmed:** Llama 4 Scout via OpenRouter (Groq-hosted) handles tool routing correctly. 1.2-1.9s round-trip with tool calls, sub-500ms for pure conversation. $0.0001/turn. System prompt tuning needed for edge cases (status checks).
- Should workers share a tool registry or each have their own? Leaning toward each-their-own for isolation.
- How does the FOH agent's context window stay lean if it's monitoring many workers? Probably needs summarization.
