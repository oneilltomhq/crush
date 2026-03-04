---
name: prospecting
description: Job/contract prospecting — discovery, qualification, and outreach preparation. Use when finding, scanning, or qualifying contract/freelance opportunities across channels (job boards, HN, LinkedIn, aggregators). Covers search strategy, channel selection, boolean queries, freshness enforcement, and structured output of qualified leads.
---

# Prospecting

Find, qualify, and prepare actionable job/contract opportunities across multiple channels.

## Core principles

1. **Breadth first.** Scan many channels quickly before drilling into any single target.
2. **Freshness is non-negotiable.** All prospects must be ≤30 days old. Verify dates. Today is {today}.
3. **Real leads only.** Don't pad results with low-relevance filler. If a channel is dry, say so and move on.
4. **Context-aware.** Read the user's profile and resume before searching. Tailor queries to their actual skills and preferences.

## Search strategy

Use boolean operators on platforms that support them. See [references/boolean-search.md](references/boolean-search.md) for per-platform syntax.

## Channel playbooks

Channels ranked by signal — use the reference docs for channel-specific workflows:

1. **Web search** (Tavily) — cast wide first. See [references/channels.md](references/channels.md).
2. **HN Who's Hiring** — monthly threads via Algolia API. See [references/channels.md](references/channels.md).
3. **ai.engineer** — conference site (Next.js SPA, needs browser). Speakers/sponsors = companies investing in AI agents.
4. **LinkedIn Jobs** — high signal for UK contract roles. Use last, use carefully. See the `linkedin-prospecting` skill.
5. **X** — relationship/network channel. Discovery of individuals/clusters.
6. **Platform listings** (Upwork, arc.dev, lemon.io, WellFound) — lower signal but broad reach.

## Tool selection

| Tool | When to use | When NOT to use |
|---|---|---|
| **web_search** | First choice for discovery. Fast, structured. | — |
| **browse** | Sites needing JS rendering, SPAs. | Static APIs, structured search APIs. |
| **auth_browse** | Logged-in sessions only (LinkedIn, X, Gmail). | General browsing. Minimise actions — ban risk. |
| **shell** | REST APIs (HN Algolia, etc), file ops, data processing. | Web pages. Never curl for SPAs. |

## Output format

For each prospect found, record:
- **Source**: where you found it
- **Company/Role**: what the opportunity is
- **Location**: geography/remote policy
- **Date**: when posted (must be ≤30 days)
- **URL**: direct link
- **Fit notes**: why it matches the user's profile
- **Next action**: what to do with this lead

Save results to a file when done. Summarize key findings.

## What counts as a "prospect"

- Submitting a job application
- Sending a targeted message/email to a decision-maker
- Publishing content aimed at generating opportunity uptake
- Creating/updating profiles on relevant platforms

Direct conversation with a decision-maker > targeted application > content play > passive profile.

## Lessons learned

See [references/lessons-learned.md](references/lessons-learned.md) — updated after each test run.
