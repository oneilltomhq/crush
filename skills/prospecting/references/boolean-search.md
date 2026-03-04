# Boolean search syntax

Boolean search dramatically improves result quality. Use it on every platform that supports it.

## General pattern

```
("AI agent" OR "agentic AI" OR "LLM agent") AND (contract OR freelance) AND (London OR remote)
```

Prefer many specific terms over few general ones. Tailor per platform.

## LinkedIn

LinkedIn Jobs supports boolean in the keywords field:
- `AND`, `OR`, `NOT` (must be uppercase)
- Quotes for exact phrases: `"agentic AI"`
- Parentheses for grouping: `("AI agent" OR "LLM") AND contract`
- Works in: Jobs search keywords, People search, company search

## Google / Tavily

- Quotes for exact phrases
- `OR` between alternatives
- `-` for exclusion: `-recruiting -staffing`
- `site:` for domain-specific: `site:linkedin.com/jobs "agentic AI"`

## HN Algolia

- Simple keyword matching, no boolean operators
- Use specific terms: `agentic AI London contract`
- Filter by date using `numericFilters=created_at_i>TIMESTAMP`

## Indeed / Job boards

- Most support basic boolean: `AND`, `OR`, `NOT`
- Quotes for phrases
- Some support `title:` prefix for title-only search
