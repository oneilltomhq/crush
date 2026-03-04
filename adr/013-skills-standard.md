# ADR 013: Skills as the primary carrier of domain knowledge

## Status

Accepted

## Context

ADR 012 introduced agent definitions as Markdown files in `agents/`. In practice, the agent system prompts grew large as they accumulated domain knowledge — channel playbooks, search strategies, message templates, audit frameworks, and lessons learned from test runs. A single flat `.md` file has no mechanism for progressive disclosure: everything goes into the system prompt upfront, consuming context window regardless of whether it's needed for the current task.

Meanwhile, the [Agent Skills standard](https://agentskills.io) has emerged as the convention used by Pi, OpenCode, Claude Code, and other coding agents. Skills are directory-based packages with a `SKILL.md` entry point (YAML frontmatter for name/description, Markdown body for instructions) and supporting directories (`references/`, `scripts/`, `assets/`) for deeper context loaded on-demand.

Pi and OpenCode both inject skills as an `<available_skills>` XML block in the system prompt, listing name, description, and file location. The agent then uses `read` / `read_file` to load full skill content when the task matches — progressive disclosure at three levels:

1. **Metadata** (name + description) — always in context (~100 tokens)
2. **SKILL.md body** — loaded when the skill triggers
3. **Bundled resources** — loaded as needed during execution

Neither Pi's subagent extension nor OpenCode currently support a `skills:` field in agent definition frontmatter — skills are ambient and available to all agents. However, Crush's architecture is different: the FOH agent dispatches named workers, and scoping which skills a worker sees keeps their context focused.

## Decision

Domain knowledge lives in skills, following the Agent Skills standard. Agent definitions become thin orchestration layers.

### Skills

Skills live in `crush/skills/<name>/` as directories:

```
skills/
├── prospecting/
│   ├── SKILL.md              # core workflow, constraints, tool selection
│   └── references/
│       ├── channels.md        # per-channel playbooks
│       ├── boolean-search.md  # search syntax per platform
│       └── lessons-learned.md # accumulated from test runs
├── linkedin-prospecting/
│   ├── SKILL.md
│   └── references/
│       ├── search-and-qualify.md
│       └── message-sequences.md
└── linkedin-profiling/
    ├── SKILL.md
    └── references/
        └── audit-framework.md
```

Each `SKILL.md` has YAML frontmatter with `name` and `description` (per the standard). The body contains core instructions. Detailed reference material, lessons learned, and channel-specific playbooks go in `references/` and are loaded on-demand by the agent.

### Agent definitions

Agent definitions in `agents/*.md` gain a `skills:` YAML field — a comma-separated list of skill slugs:

```yaml
---
name: prospector
tools: web_search, browse, auth_browse, read_file, write_file, shell
skills: prospecting
model: worker
---
```

The agent body stays thin: persona, delegation style, and a pointer to load skills. Domain knowledge moves to skills.

### Dispatch integration

When a worker agent is dispatched, `agent-loader.ts` resolves the agent's `skills:` list and appends an `<available_skills>` XML block to the system prompt — matching the Pi/OpenCode convention. The worker uses `read_file` to load full skill content when needed.

### Lessons learned process

Each skill can have a `references/lessons-learned.md` that accumulates observations from test runs. When a skill's SKILL.md body grows too large trying to accommodate all lessons, that's the signal to either move content to references or decompose into narrower skills.

## Consequences

**Domain knowledge is portable.** Skills follow the Agent Skills standard and could be used in Pi, OpenCode, or any harness that supports the standard, without modification.

**Progressive disclosure reduces context waste.** Only skill metadata is always present. Full instructions and references load on-demand.

**Agent definitions stay lean.** Adding a new domain (e.g., content marketing, technical writing) means creating a skill directory and pointing an agent at it — no large prompt rewrites.

**The `skills:` field in agent frontmatter is a Crush extension.** It doesn't conflict with the Agent Skills standard (which doesn't define agent frontmatter) but isn't yet supported by Pi or OpenCode natively. If those tools add a similar field later, we'll align.

**Backward compatible.** The legacy `skill:` (singular) field is still parsed and merged with `skills:`. Agents without skills continue to work as before.
