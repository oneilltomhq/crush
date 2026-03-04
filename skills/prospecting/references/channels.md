# Channel playbooks

## Web search (Tavily)

First choice for broad discovery. Use boolean-style queries to find live contract listings on aggregators (Data Freelance Hub, GCS Tech Talent, etc.).

**When it works well:** Finding active listings across multiple platforms in one sweep.
**When it doesn't:** When you need to interact with the page (apply, log in, navigate SPAs).

## HN Who's Hiring

Monthly threads on Hacker News. Use the Algolia API for structured search:

```
https://hn.algolia.com/api/v1/search?tags=comment,story_THREADID&query=SEARCH_TERMS&hitsPerPage=50
```

**Finding the current thread:** Search for `Ask HN: Who is hiring? (MONTH YEAR)` on the HN front page or via Algolia with `tags=story,ask_hn`.

**Critical:** Always start with the current month's thread. Never search threads older than 2 months. HN threads are monthly — if it's March 2026, the relevant threads are March and February 2026 only.

**Characteristics:** Skews US/onsite and full-time. Few contract roles, few London-based. Useful for identifying companies building in the agentic AI space even if they don't have a perfect-fit role listed.

## ai.engineer

Conference site. Next.js SPA — requires browser automation, not curl/fetch.

**What to look for:** Speakers and sponsors = companies investing heavily in AI agents. Cross-reference with job boards.
**Known issue:** Site structure changes between events. Snapshot first, navigate carefully.

## LinkedIn Jobs

High signal for UK contract roles. Supports boolean search in the keywords field.

**Use last, use carefully.** LinkedIn rate-limits and bans aggressive automation.
See the `linkedin-prospecting` skill for detailed LinkedIn workflows.

## X (Twitter)

Relationship and network channel. Not for job listings — for discovering individuals and clusters in the agentic AI space.

**What to look for:** People building/shipping agentic tools, hiring threads, company announcements.

## Platform listings

- **Upwork** — broad, competitive, lower rates
- **arc.dev** — vetted, remote-focused
- **lemon.io** — vetted, European-friendly
- **WellFound (AngelList)** — startup-focused

Lower signal per unit but broad reach. Good for filling pipeline gaps.
