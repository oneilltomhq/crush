# ADR 010 — Consultative FOH Behavior

**Status:** proposed

## Context

ADR 009 established the FOH/worker split: Scout handles conversation, delegates heavy work to background agents. The current FOH system prompt treats Scout as a **task router** — user says what they want, Scout delegates, done.

But real user stories aren't single tasks. Take "help me identify my ideal client" (US-2.1). The user says "I need a contract in London in tech." What should happen next?

Bad answer: immediately delegate a generic research task about "ideal clients in London tech."

Good answer: Scout acts as a **consultant**. It probes: What's your stack? What kind of companies — startups, banks, scale-ups? Have you contracted before? What rates are you targeting? Only once it has enough signal does it know *what* to research. And even then, the research comes back in rounds:

1. **Intake** — discover who the user is, what they want, what constraints exist
2. **Market mapping** — London's geographic tech segmentation (City ≠ Shoreditch ≠ King's Cross), who's hiring contractors where
3. **Company profiling** — specific targets, stacks, rates, culture
4. **People mapping** — decision-makers, engineering leads at target companies (LinkedIn/X)
5. **Strategy synthesis** — actionable targeting plan

Each phase's output feeds the next phase's research brief. This is an **iterative, multi-round engagement**, not a one-shot delegation.

## Decision

We evolve the FOH agent from task router to **consultative agent** through three changes:

### 1. System prompt: intake-before-delegation pattern

The FOH system prompt gains an explicit intake protocol. Before delegating research, Scout must establish:
- Who is the user (skills, experience, location)
- What do they want (type of work, companies, timeline)
- What constraints exist (rate expectations, travel, remote/hybrid)

If this context is missing from the user profile, Scout **asks** before delegating. Two to three focused questions, not a 20-question form.

### 2. Profile accumulation

As the conversation progresses, Scout writes discovered facts to `~/.crush/profile/` using `write_file`. This persists across sessions. The profile is injected into the system prompt on connect, so returning users skip intake.

### 3. Chained research with context threading

When research completes, Scout reads the result (it's in a pane / the notification summary), decides what to research next, and delegates again with a more specific brief that references prior findings. The FOH prompt explicitly tells Scout to do this — don't stop at one research round when the user's goal is multi-dimensional.

No new tools or infrastructure needed. This is purely a system prompt and behavioral change.

## What we're NOT doing

- **No workflow engine** — we're not building a state machine for "consulting sessions." Scout's conversational memory + profile files are the state.
- **No session templates** — each user story follows a different path. Scout decides what to ask and research based on context, not a predefined flow.
- **No changes to worker architecture** — research workers, shell workers, browser workers all work as-is.

## Consequences

**Good:**
- User stories become genuinely useful (not just "run a search and dump results")
- Profile accumulation means the system gets smarter over sessions
- No new infrastructure — pure prompt engineering with the existing tool set
- The richness of stories like WHO identification gets properly served

**Risky:**
- Scout (Llama 4 Scout) may not be sophisticated enough for good intake behavior. If it's too eager to delegate or too shallow in probing, we may need a smarter FOH model.
- Long multi-round sessions accumulate context — the 20-message trim in `processText()` might cut important earlier context. May need smarter summarization.
- Chained research multiplies cost (each round is ~$0.05). Need to ensure Scout doesn't research endlessly.

**Testing approach:**
- Live test with the real WHO identification story using `cli-chat.ts`
- Evaluate: does Scout probe before delegating? Does it chain research intelligently? Does it save profile context?
- Tune the prompt based on observed behavior, not theory.
