---
name: linkedin-automation
description: Driving LinkedIn through agent-browser and CDP — the specific techniques that work (and the traps that don't) for editing profile fields, navigating forms, and submitting Easy Apply. Covers ProseMirror contenteditable gotchas, execCommand patterns, and verification. Read this before touching LinkedIn with agent-browser.
---

# LinkedIn via agent-browser

Operate the user's authenticated LinkedIn session in the auth browser (Chrome on port 9223) using agent-browser with CDP.

## Connection pattern

```sh
CDP_WS=$(curl -s http://localhost:9223/json/version | python3 -c "import json,sys; print(json.load(sys.stdin)['webSocketDebuggerUrl'])")
agent-browser --cdp "$CDP_WS" <command>
```

Always use the full websocket URL. Never use bare port.

## Profile URL

The user's profile slug is `oneilltomhq`: `https://www.linkedin.com/in/oneilltomhq/`

Edit forms are at: `https://www.linkedin.com/in/oneilltomhq/edit/forms/<section>/new/`

Known sections: `summary` (About), `position` (Experience), `education`, `skills`.

## Editing contenteditable fields (ProseMirror)

LinkedIn uses ProseMirror for rich text fields. ProseMirror maintains its own internal document state independently of the DOM.

### What works

**`document.execCommand` is the only reliable method.** ProseMirror intercepts these calls and updates its internal state, which is what gets sent to LinkedIn's API on save.

```js
// In agent-browser eval:
const el = document.querySelector('[contenteditable]') || document.querySelector('[role=textbox]');
el.focus();
document.execCommand('selectAll', false, null);
document.execCommand('delete', false, null);

document.execCommand('insertText', false, 'First paragraph.');
document.execCommand('insertParagraph');  // = one blank line between paragraphs
document.execCommand('insertText', false, 'Second paragraph.');
```

One `insertParagraph` = one visual blank line on the rendered profile.

### What does NOT work

- **`el.innerHTML = ...`** — Silently ignored. ProseMirror re-serializes from its own state on save.
- **`agent-browser keyboard inserttext` with newlines** — Newlines get multiplied by ProseMirror. Use `execCommand` instead.
- **`el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', ...}))`** — ProseMirror doesn't pick these up.

### Editor re-open inflation (cosmetic, ignore it)

After saving clean paragraph breaks, re-opening the edit form shows extra blank lines in the editor. This is ProseMirror re-rendering `<p>` tags with trailing `<br class="ProseMirror-trailingBreak">` elements. The actual stored/displayed content on the profile is correct. Do not "fix" this.

## Saving

After editing, find the Save button:

```sh
agent-browser --cdp "$CDP_WS" snapshot 2>&1 | grep -i save
# Then:
agent-browser --cdp "$CDP_WS" click @eNN
```

## Verifying changes

After saving, navigate back to the profile and check the rendered content:

```sh
agent-browser --cdp "$CDP_WS" navigate "https://www.linkedin.com/in/oneilltomhq/"
agent-browser --cdp "$CDP_WS" snapshot 2>&1 | grep -i -A5 "about"
```

The accessibility tree's `paragraph` content reflects what visitors see. Trust this over the edit form's visual rendering.

## Screenshots

- `agent-browser screenshot` — viewport only
- `agent-browser screenshot --full` — full page (but LinkedIn lazy-loads, so may not capture everything)
- `agent-browser screenshot --annotate` — labeled interactive elements with ref numbers

To see a specific section, scroll it into view first:

```js
const headings = [...document.querySelectorAll('h2')];
const h = headings.find(h => h.textContent.trim().startsWith('About'));
h?.scrollIntoView({block: 'start'});
```

## Lessons learned

- Don't spawn multiple subagents for browser tasks. Do them sequentially in one auth'd session.
- If the user is looking at the same auth browser, it causes interference.
- `agent-browser keyboard inserttext` works for simple single-line fields but not for ProseMirror rich text.
- Always verify saves by re-navigating to the profile, not by re-opening the edit form.
