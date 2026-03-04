---
name: linkedin-prospecting
description: LinkedIn outreach prospecting — search, connect, message, and follow-up sequences. Use when finding prospects on LinkedIn, sending connection requests, managing outreach sequences, or tracking LinkedIn prospecting metrics. Covers rate limits, message templates, qualification criteria, and pending invite hygiene.
---

# LinkedIn Prospecting

Find ideal prospects on LinkedIn, send personalised connection requests, manage follow-up sequences, and track metrics — all within LinkedIn's rate limits.

Operate the user's authenticated LinkedIn session via auth_browse. **This is a real account with real reputation consequences.**

## Rate limits (hard rules)

- **Max 50 connection invites per day**
- **Max 100 messages per day**
- **Withdraw pending invites older than 4 weeks** (weekly hygiene)
- Never exceed these. LinkedIn flags and bans accounts that do.

## Search strategy

See [references/search-and-qualify.md](references/search-and-qualify.md) for finding and qualifying prospects.

## Message templates

See [references/message-sequences.md](references/message-sequences.md) for connection requests, welcome messages, and follow-up sequences.

## Pending invite hygiene

Weekly:
1. Go to My Network → Manage Invitations → Sent
2. Withdraw any invites older than 4 weeks
3. If sending 50/day, withdraw anything older than 1 week

## Metrics to track

Maintain a tracking file with:
- **Invites sent** (daily count)
- **Acceptance rate** (target: 50%+; if below, adjust messaging or targeting)
- **Response rate** to welcome messages
- **Conversations moved offline** (calls/meetings booked)
- **Pending invites** outstanding

### Goal decomposition

connections_needed ÷ time_available = connections/day
connections/day ÷ acceptance_rate = invites/day
Validate invites/day ≤50; if not, extend timeline or improve acceptance rate.

## Output format

```markdown
## LinkedIn Prospecting Session — {date}

### Activity
- Invites sent: X
- Welcome messages sent: X
- Follow-ups sent: X
- Pending invites withdrawn: X

### New connections
| Name | Title | Company | Location | Notes |
|---|---|---|---|---|

### Conversations
| Name | Status | Next action | Date |
|---|---|---|---|

### Metrics
- Acceptance rate (rolling 7d): X%
- Response rate (rolling 7d): X%
- Calls booked this week: X
```

## Key principles

1. **Breadth first.** Scan many prospects before drilling into any one.
2. **Seek first to understand, then to be understood.**
3. **Pain and pleasure.** Reference problems they want to escape and outcomes they want to reach.
4. **WIIFM.** Every message answers "What's In It For Me?" from the prospect's perspective.
5. **Warm > cold.** Shared connections, profile viewers, engaged commenters convert better.
