# ADR 006: Voice-Only Interaction

**Status:** accepted

## Context

Crush started as a keyboard-and-mouse 3D terminal with voice as an add-on. The result was a cluttered UI: a HUD bar showing 8+ keyboard shortcuts, mouse click-to-focus and click-to-dive, scroll-wheel on text panes, a floating mic button, DOM overlay transcript bubbles — all competing for attention in a space that should feel calm and spatial.

The keyboard shortcuts (A/B/S/D/X/P) were developer conveniences for testing pane creation, not real user interactions. Mouse focus and dive were technically clever but confusing — the same click gesture did different things depending on state. The mic button was the only input that mattered for the actual use case.

The core product insight: this is a workspace you talk to, not a terminal you type into. The agent manages all panes, navigation, and execution. The user directs with voice.

## Decision

Voice is the exclusive input modality. We removed:

- All keyboard shortcuts for pane management
- All mouse/touch interaction for focus, navigation, and scroll
- The HUD bar
- The mic button (tap anywhere on the canvas to toggle conversation)

What remains:

- Voice commands processed by the LLM create, modify, and destroy panes
- A minimal transcript display at the bottom of the viewport
- A tiny connection status dot (top-right)
- Scene atmosphere (background color) shifts subtly with voice state

This is a creative constraint and a forcing function. If something can't be done by voice, we make the voice pipeline better rather than adding a keyboard fallback.

## Consequences

**Good:**
- Dramatically simpler input layer — no raycaster, no keyboard dispatch, no focus state machine
- Forces investment in voice UX quality (the only path to usability)
- Clean, calm visual design — the workspace is a display surface, not a control panel
- grid-scene.ts dropped from 1048 to 505 lines

**Hard:**
- Scrolling text panes now requires a voice command or LLM-driven scroll — need to add this
- Developer testing is slower (can't just press 'B' to create a browser pane)
- Latency in the voice pipeline becomes the primary UX bottleneck
- No fallback for environments where voice isn't available (noisy room, no mic)

**Open questions:**
- Should we add a minimal escape hatch (e.g. a text input box) for situations where voice fails?
- How do we handle fine-grained interactions like "scroll down a bit" gracefully?
