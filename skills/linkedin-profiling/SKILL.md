---
name: linkedin-profiling
description: LinkedIn profile optimisation — audit, rewrite, and enhance a LinkedIn profile for conversion. Use when auditing a LinkedIn profile, rewriting sections (headline, about, experience), improving recommendations strategy, or optimising skills/endorsements for search visibility.
---

# LinkedIn Profile Optimisation

Audit a LinkedIn profile against proven conversion principles and produce specific, implementable recommendations or rewrites.

Operate the user's authenticated LinkedIn session via auth_browse to read the current profile state. **Do NOT make changes to the profile directly unless explicitly instructed.** Default mode is audit + draft.

## Audit framework

Score each section on a 1-5 scale. Provide the current state, what's wrong, and a concrete rewrite.

See [references/audit-framework.md](references/audit-framework.md) for the detailed per-section audit criteria.

## Output format

```markdown
# LinkedIn Profile Audit — {name}

**Date:** {date}
**Profile URL:** {url}
**Overall score:** X/50

## Section scores

| Section | Score | Key issue |
|---|---|---|
| Banner | X/5 | ... |
| Photo | X/5 | ... |
| Headline | X/5 | ... |
| Contact | X/5 | ... |
| About | X/5 | ... |
| Experience | X/5 | ... |
| Recommendations | X/5 | ... |
| Skills | X/5 | ... |
| Content | X/5 | ... |
| Education | X/5 | ... |

## Priority actions (ranked by impact)

1. ...
2. ...
3. ...

## Detailed findings
(per section)

## Drafts
(full rewrites where needed)
```

Save the audit to a file. Summarise the top 3 actions when reporting back.

## Key principles

1. **WIIFM drives everything.** Every word must answer what's in it for the reader.
2. **Make it easy.** Easy to find, connect with, contact, buy from.
3. **Less is more.** Edit ruthlessly. If 4 lines can be 2, cut.
4. **Pain and pleasure.** Name the problem, then the solution.
5. **"So what?" and "In what way?"** Apply to every claim.
6. **Rule of Threes.** Lists of three are psychologically sticky.
7. **Consistency across platforms.** Photo, messaging, brand — same everywhere.
