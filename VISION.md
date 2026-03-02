# crush — vision

## The idea

Crush is a workspace you talk to. The user speaks, observes, and directs. The agent does the work — browsing, coding, researching, filing, scheduling — invisibly. Results materialize in a 3D spatial scene as organized clusters of information. The user's role is creative direction, not mechanical execution.

The interaction model is closer to meditation than to typing. The user stays in a diffuse, creative mental state while the system handles decomposition, execution, and synthesis. Voice-only input is a forcing function for this: no keyboard, no mouse, no clicking through menus.

## Spatial computing grounded in neuroscience

The 3D scene isn't a gimmick. It's designed to exploit specific, well-understood properties of human cognition.

### Spatial memory (hippocampal place encoding)

Humans have extraordinary spatial recall. The hippocampus encodes *where* things are — the same system that lets you navigate a city from memory or remember which shelf you left a book on. The method of loci ("memory palace") technique exploits this: place items in imagined spatial locations, and recall improves dramatically.

When crush arranges work spatially — this research cluster is top-left, that code review is bottom-right, the calendar stuff is behind you — the user's spatial memory system tracks it automatically. They don't need to remember what's where; they *feel* where it is.

**Design implication:** Pane positions should be stable and meaningful, not arbitrary. Once a cluster forms in a region of space, it stays there. Spatial consistency builds spatial memory.

### Chunking (Miller, 1956 — working memory limits)

Working memory holds roughly 4±1 chunks. But chunk *size* is flexible — a single chunk can be a letter, a word, a concept, or an entire project if it's been compressed into a coherent unit.

When the agent decomposes a complex task into 3–5 spatially separated clusters, each cluster becomes one chunk. A 40-item problem becomes 4 graspable units. The 3D spatial layout *is* the chunking mechanism.

**Design implication:** Top-level views should show 3–5 clusters, not 20 items. Decomposition should produce a small number of meaningful groups. Drilling into a cluster reveals its internal structure at the same 3–5 item density.

### Cognitive offloading (Clark & Chalmers — extended mind thesis)

The "extended cognition" hypothesis: cognitive processes aren't confined to the brain. A well-organized notebook, a carefully arranged desk, a phone with your contacts — these are part of your cognitive system. You think *with* them, not just *about* them.

The crush workspace is a cognitive prosthesis. When the agent arranges and maintains the spatial scene, it's literally extending the user's cognitive capacity. The user doesn't hold the project structure in their head because it's *right there* in space, being maintained by the agent.

**Design implication:** The scene should reflect the user's mental model, not the system's internal data model. If the user thinks of their work as "the LinkedIn campaign" and "the code review" and "the research," those should be the visible clusters — not "agent-task-47" and "browser-pane-12."

### Attentional spotlight and peripheral awareness

Foveal vision is sharp but narrow (~2° of arc). Peripheral vision is low-resolution but exquisitely sensitive to motion and change. The visual system is built for exactly this: focus on one thing while monitoring everything else for changes.

This maps to the workspace: the focused cluster is detailed and readable. Surrounding constellations are visible but dimmed. When an agent completes work on a distant cluster, a subtle animation or glow pulls peripheral attention — no notification popup needed. The spatial system *is* the notification system.

**Design implication:** Use motion and color shifts, not text notifications. A cluster that just received new results should breathe or pulse gently, not pop up a toast. The user's peripheral vision will catch it.

### Default mode network and diffuse thinking

The brain's default mode network (DMN) is active during unfocused, wandering thought — and it's where creative insights, novel connections, and big-picture thinking happen. The DMN is *suppressed* by focused, detail-oriented tasks like clicking, typing, navigating menus, and managing windows.

Voice-only interaction plus spatial observation may keep the user closer to this diffuse creative state. They're not task-switching between "think about the problem" and "figure out which button to click." They just speak and observe.

**Design implication:** Minimize anything that pulls the user into focused mechanical interaction. No buttons, no menus, no text fields. If the user has to *operate* the interface, we've failed. They should only have to *direct* it.

## The cosmos metaphor

The 3D scene is a cosmos. Work items are stars. Related work clusters into constellations. The user floats above, observing, occasionally speaking a new direction into existence.

This isn't just poetry — it's a design language:

- **Stars** — individual work items (a finding, a file, a message)
- **Constellations** — clusters of related work (a research project, a code review, a campaign)
- **Nebulae** — work in progress, not yet crystallized (an agent actively researching, results still forming)
- **Orbits** — temporal/dependency relationships (this depends on that, this came from that)

The cosmos grows as work accumulates. Old completed constellations drift to the periphery. Active work stays central. The spatial arrangement reflects relevance and recency, not creation order.

## What the agent does vs. what the user sees

The agent's work is invisible labor. It browses the web, reads pages, clicks through forms, writes code, calls APIs. The user does not see this happening — they see *results*.

A research task doesn't show 10 browser tabs loading. It shows a constellation forming: key findings appearing as nodes, clustering by theme, with a synthesis document crystallizing at the center.

A LinkedIn outreach task doesn't show the agent clicking through profiles. It shows a cluster of candidate connections, annotated with relevance, with draft messages ready for review.

The browser is an implementation detail of the agent, not a surface for the user.
