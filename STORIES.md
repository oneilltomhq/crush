# crush — user stories

Living document. Stories describe **what the user wants to accomplish**, not implementation. Each story should be testable end-to-end through the voice interface.

---

## US-1: Contract lead finder

**As a** freelance AI/agentic engineer looking for work,  
**I want to** tell Crush what kind of contracts I'm after and have it find, qualify, and summarise leads,  
**so that** I spend my time on outreach and interviews, not trawling job boards.

### Happy path

1. User says: "Find me AI agent engineering contracts — remote, 3-6 months, $150+/hr."
2. Crush confirms the brief and kicks off research (Tavily searches across job boards, freelance platforms, LinkedIn job posts, HN Who's Hiring, etc.).
3. Research results appear in a **text pane** — a ranked shortlist of leads with company, role, rate/salary, source URL.
4. User reviews the list by voice: "Tell me more about the second one" → Crush fetches the full listing, shows it in a text pane.
5. User says: "That one looks good, open it" → Crush opens the listing in a **browser pane** (auth_browse if it's LinkedIn, browse otherwise).
6. User says: "Save the top 3 to my leads file" → Crush writes a structured markdown file to `~/.local/share/crush/leads/`.

### What makes this a good first story

- Uses **existing capabilities**: web_search, auth_browse, text panes, file writing. No new pane types needed.
- It's a **real workflow** the developer actually wants to do, not a toy demo.
- Exercises the consultative pattern (US-2): Crush probes for criteria, researches in rounds, refines.
- Natural follow-ups: "search again but include part-time", "check if that company has other openings", "draft an intro message".
- Demoing it is compelling — voice-driven job search that actually works.

### What needs to work

1. **Research pipeline** delivers focused, deduplicated results (just fixed: Tavily-only sub-runners).
2. **FOH prompt** knows how to structure the lead-finding workflow (probe → research → present → drill-down → save).
3. **Text pane rendering** handles the shortlist cleanly (markdown table or structured list).
4. **auth_browse** works for LinkedIn drill-down (requires SSH tunnel to user's browser).
5. **File save** to `~/.local/share/crush/leads/` with structured format.

### Gaps to close

- FOH needs a workflow hint for lead-finding (or a general "structured research → artifact" pattern).
- `leads/` directory and save format need defining.
- Research pipeline needs to return results in a structured format the FOH can present as a ranked list, not just a prose dump.
- Text pane scrolling/selection UX for reviewing a list by voice ("tell me about number 3").

---

## US-2: Consultative research (general)

**As a** user with a complex goal,  
**I want** Crush to probe, research in rounds, and build up a picture iteratively,  
**so that** I get genuinely useful results, not a generic one-shot search dump.

*(See ADR-010 for the consultative behavior pattern.)*

---

## US-3: (template for future stories)

**As a** ...,  
**I want to** ...,  
**so that** ...

---

## Retired / deferred

### US-X: Run distance calculator (deferred)

Originally US-1. Fun proof-of-concept but requires building MapPane, geocoding, route plotting — significant effort for a capability the primary user doesn't need right now. Could revisit as a showcase demo later.
