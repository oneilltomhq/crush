# ADR 012: Agent Definitions as Markdown Files

## Status

Accepted

## Context

Crush's worker agents (shell, browser) had system prompts hardcoded as string constants in `agent-server.ts`. Adding new agent types — like a prospecting agent with domain-specific knowledge, tool selection rules, and search strategies — meant editing TypeScript code to add more string constants and if/else branches.

Meanwhile, the Pi ecosystem has converged on a pattern for defining agents as Markdown files with YAML frontmatter. The [pi-subagents](https://github.com/nicobailon/pi-subagents) extension pioneered this: `.md` files where the body is the system prompt and frontmatter declares the agent's name, description, tools, model, and other configuration. OpenCode adopted a similar pattern. This format is human-readable, diff-friendly, and separates domain knowledge from orchestration code.

Crush already had `WorkerAgent`, a generic class that accepts a system prompt, tool list, and model as constructor parameters — the exact shape an agent definition file provides.

## Decision

Agent definitions live as Markdown files in `crush/agents/`. Each file follows the pi-subagents convention:

```markdown
---
name: prospector
description: Job/contract prospecting — discovery, qualification, outreach prep.
tools: web_search, browse, auth_browse, read_file, write_file, shell
model: worker
skill: prospecting
---

(System prompt body — full markdown, as long as needed)
```

A loader (`server/agent-loader.ts`) parses these files at startup and provides:
- `loadAgents()` — all definitions as a `Map<string, AgentDef>`
- `getAgent(name)` — single lookup
- A tool registry that maps tool name strings to `AgentTool` factory functions
- `resolveTools(names, ws?)` — turns frontmatter tool lists into live tool instances

The FOH agent's `delegate_task` tool accepts an `agent` parameter (named agent) alongside the legacy `worker_type`. When a named agent is used, its definition drives the WorkerAgent's prompt, tools, and model. The built-in `research` pipeline (AgentRunner, 3-phase) remains as-is since it has fundamentally different orchestration.

Model aliases (`worker`, `research`, `foh`) map to concrete model configurations in the server, keeping agent definitions portable.

Template variables in system prompts (e.g. `{today}`) are expanded at dispatch time.

## Consequences

**Adding a new agent type requires no TypeScript changes.** Drop a `.md` file in `agents/`, restart. The FOH agent automatically sees it in its tool description and can delegate to it.

**Domain knowledge is separated from orchestration.** The prospecting agent's search strategies, channel rankings, and freshness constraints live in `agents/prospector.md`, not buried in a TS string constant.

**The format is compatible with pi-subagents.** If we later integrate with Pi editor workflows, agent definitions are already in the right shape. We don't use the pi-subagents extension as a dependency — we just adopted its file format.

**Legacy worker types still work.** `worker_type: 'shell'` and `worker_type: 'browser'` continue to function via the hardcoded fallback paths, but new agents should use the definition format. The old `SHELL_WORKER_PROMPT` and `BROWSER_WORKER_PROMPT` constants remain as fallbacks but are now redundant with `agents/shell.md` and `agents/browser.md`.

**Skills (referenced in frontmatter) are not yet wired.** The `skill` field is parsed but not acted on. A future change could load skill content from separate files and inject it into prompts, following the Pi skills pattern. For now, domain knowledge goes directly in the agent's system prompt body.
