# ADR 011 — Action-Oriented FOH Behavior

**Status:** proposed

## Context

ADR 010 made the FOH agent consultative: it probes before delegating, chains research, accumulates context. This was a good step, but in practice Crush still *feels like a chatbot*. The user says something, Crush responds conversationally, and the exchange is indistinguishable from talking to ChatGPT.

The problem: Crush has a **3D spatial workspace** with panes, maps, terminals, browsers, text surfaces — but the FOH agent's default mode is to *talk about things* rather than *do things in the scene*. When a user says "I just went for a run and want to figure out how far it was," the chatbot response is to discuss running and ask questions. The Crush response should be to bring up a map, start plotting waypoints, and compute the distance — with conversation happening *around* the actions, not instead of them.

This is the fundamental UX distinction between Crush and a chat interface: **Crush co-pilots tasks in a spatial workspace. The scene is the primary output, not the transcript.**

## Decision

We add an **action bias** to the FOH system prompt and tool design. Three concrete changes:

### 1. System prompt: scene-first orientation

The FOH prompt gains explicit guidance that Crush should:

- **Bias toward creating artifacts in the scene** — panes, maps, terminals, visualizations — rather than just speaking.
- **Show, don't just tell.** If the answer can be a visual artifact (map, chart, code, document), make one. If it can only be spoken, speak it.
- **Co-pilot, don't lecture.** When the user describes a task, Crush's first instinct should be "what can I put in the scene to help with this?" not "let me explain how we could approach this."
- **Act, then confirm.** It's better to bring up a map and say "I've pulled up your area — walk me through the route" than to say "I could bring up a map for you, would you like that?"

This does NOT mean Crush fires tools recklessly. The existing confirmation rule (ADR 010) still applies for external actions. But creating workspace artifacts — panes, visualizations, local files — should be eager, not gated behind permission.

### 2. Richer pane vocabulary

The current pane types are: `text`, `terminal`, `pty`, `browser`. To support action-oriented behavior across diverse user stories, we need:

- **`map`** — interactive map surface (Leaflet/Mapbox) for geospatial tasks
- **`html`** — arbitrary HTML rendered into a pane (charts, custom UIs, forms)
- **`image`** — static image display (screenshots, generated images, diagrams)

Each new pane type comes with associated tools the FOH can call to manipulate it.

### 3. Tool design principle: composable scene actions

New tools should follow a pattern:
- `create_pane` brings something into the scene
- Domain-specific tools manipulate pane content (e.g., `add_map_marker`, `plot_route`, `set_html_content`)
- The FOH weaves these into conversation naturally

The test for any new tool: *does this make something visible happen in the scene?* If yes, it belongs in the FOH's direct toolkit. If it's pure background computation, it belongs in a worker.

## Consequences

**Good:**
- Crush feels fundamentally different from a chatbot — it *does things* you can see
- User stories like run tracking, data analysis, code review become spatial experiences
- The 3D workspace stops being decorative and becomes the primary interaction surface
- Natural progression: each new pane type unlocks a category of user stories

**Risky:**
- Over-eager scene manipulation could feel chaotic — need taste in when to create vs. when to ask
- New pane types are real engineering work (MapPane alone is 2-3 days)
- FOH model (Llama 4 Scout) may not reliably choose "show" over "tell" — may need prompt iteration or a smarter model
- More tools in the FOH context = more token overhead per turn

**Key metric:** After a typical 5-minute voice session, the scene should have 2-3 artifacts the user created collaboratively with Crush. If the scene is empty and the transcript is long, we've failed.
