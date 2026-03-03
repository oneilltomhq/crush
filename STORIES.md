# crush — user stories

Living document. Stories describe **what the user wants to accomplish**, not implementation. Each story should be testable end-to-end through the voice interface.

---

## US-1: Contract procurement — map the landscape

**As a** freelance AI/agentic engineer looking for contract work,  
**I want** Crush to help me build a structured picture of the market I'm operating in,  
**so that** I can pursue opportunities from a position of clarity, not guesswork.

### The insight

Finding contracts isn't a search problem — it's a mapping problem. Before you can evaluate any lead, you need to know the territory:

- **Demand landscape**: Where is AI agent work happening? Startups building agent products, enterprises adopting agent tooling, agencies staffing AI projects, open-source orgs funding development.
- **Engagement models**: Staff augmentation, fixed-scope project, retainer/fractional, full embedded team member. Each has different rate dynamics and sales cycles.
- **Channels**: LinkedIn jobs, Toptal/Turing/Gun.io, HN Who's Hiring, X/Twitter network, warm intros, specialist recruiters, direct outreach to founders. Which have signal for *this* kind of work?
- **Positioning**: What's your specific edge? "AI engineer" is noise. "Built a voice-driven agentic workspace with browser automation, VT emulation, and 3D spatial UI" is signal. How does your portfolio map to what buyers are actually looking for?
- **Rate/terms reality**: What are people actually paying for senior agentic engineering? How does remote vs. on-site, US vs. UK, W-2 vs. 1099/Ltd affect that?

### Happy path

1. User says: "I need to find AI agent engineering contracts. Help me map out the landscape."
2. Crush probes briefly — what kind of work, what geo, any constraints? (Not a form — a quick exchange.)
3. Crush kicks off research — but structured by *facet*, not keyword. Sub-queries target: demand signals, engagement models, active channels, rate benchmarks, competitive positioning.
4. Results arrive as a **landscape pane** — a structured text artifact organizing the territory, not a list of job posts.
5. User and Crush refine the map together: "I think the startup/seed-stage segment is most interesting" → Crush drills deeper into that facet.
6. Once the landscape is clear, user says: "Okay, now find me actual leads in the startup segment" → *that's* when lead generation starts, informed by the map.
7. Leads are qualified against the landscape: "This one's a Series A building agent infra — strong fit based on your profile" vs. "This is staff aug for a bank's chatbot — low fit."

### Phases (each produces a scene artifact)

| Phase | Artifact | What it is |
|---|---|---|
| 1. Landscape | Market map pane | Structured view: segments, channels, rate ranges, demand signals |
| 2. Positioning | Positioning pane | User's edge, portfolio-to-market fit, talking points |
| 3. Leads | Pipeline pane | Qualified leads with fit scores against the map |
| 4. Outreach | Drafts pane | Tailored messages per lead, tracking status |

US-1 is **phase 1 only**. Get the map right. The other phases are natural follow-on stories.

### What needs to work

1. **Research pipeline** can be briefed by facet (not just keyword search). The planner needs to decompose "map the landscape" into structured sub-queries per facet.
2. **FOH** understands this is a multi-artifact, multi-round workflow — not "search and dump."
3. **Synthesis** produces structured output (sections, not narrative) that maps to the territory.
4. **Text pane** renders the map artifact clearly — the user should be able to look at it and see the landscape.
5. **Iterative refinement**: user can say "drill into the startup segment" and the map updates/expands.

### What already works

- Research pipeline with Tavily-only sub-runners.
- Text pane creation and updating.
- FOH delegation to research workers.
- Profile data (Crush already knows the user's GitHub/background).

### Gaps to close

- FOH prompt needs guidance on *landscape-style* research vs. generic search delegation.
- Research planner prompt could be improved to decompose by facet when the goal is "map" not "find."
- Synthesis prompt needs to produce structured artifact, not narrative essay.
- No mechanism yet for "drill into this section" → targeted follow-up research that *updates* an existing pane rather than creating a new one.

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
