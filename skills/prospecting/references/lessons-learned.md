# Lessons learned

Updated after each test run of prospecting agents.

## 2026-03-04 — First live run

- **Stale data:** Agent searched July 2025 HN threads when it was March 2026. Root cause: no date awareness in prompt. Fix: freshness constraint + {today} template variable now in skill.
- **ai.engineer scraping flaky:** Tried to curl a Next.js SPA. Fix: tool selection table now explicit about SPA = browser, not curl.
- **Subagent timeouts:** Delegated scraping to subagents that timed out. Fix: if it times out once, take over directly. Don't re-delegate flaky tasks.
- **LinkedIn over-automation risk:** Started automating LinkedIn searches aggressively. Fix: LinkedIn is last channel, minimal actions, explicit rate limits.
- **Boolean search unused:** Generic keyword searches returned generic results. Fix: boolean search reference doc added with per-platform syntax.
- **No profile context:** Agent searched without knowing the user's actual skills/experience. Fix: read profile/resume before searching.
