---
name: mark-sbb
description: Companion skill for the Mark MCP (@silverbackbase/mark) — headless micro-analytics for AI agents. Guides the agent through instrumenting an app, reading behavioral data, and iterating based on real user behavior. Use when: delivering or iterating on an HTML/JS app, asked to measure user behavior, asked about funnels or drop-off, wanting to compare before/after a change, running A/B tests, tracking individual user journeys, or when Trail attribution data needs to be paired with in-app behavior.
---

# Mark — Agent Workflow Guide

Mark runs on `http://localhost:7331`. Check it's alive before any operation: `GET /health`.

## When to use Mark

- After delivering an HTML app, game, onboarding flow, or multi-step form
- Before iterating: read what users actually do, don't guess
- After a change: compare behavior before/after with `mark_compare`
- For A/B tests: tag events per variant, compare with `tag` filter
- To debug a specific user's path: use `mark_journey` with their `entity_id`
- When Trail tells you where a user came from, Mark tells you what they did next

## Instrument an app (3 steps)

1. Call `mark_snippet("my-slug")` — get the `<script>` tag
2. Paste it before `</body>` in the HTML
3. Add `window.markjs.track('event_name', { optional: 'props' })` at key moments

**Name events after user actions, not UI elements:**
- `signup_start` not `button_click`
- `step_2_complete` not `form_submit`
- `purchase` not `checkout_button`

The agent defines all event names — no schema is predefined.

### Optional tracker methods (call before or after track)

```js
markjs.identify('user-123')   // link all subsequent events to this entity ID
markjs.setTag('variant-a')    // tag all subsequent events for segmentation
markjs.track('event', props)  // send an event
```

Both `identify` and `setTag` persist for the browser session — call once, applies to all subsequent `track()` calls.

## Tools reference

| Tool | What it does | Key optional params |
|------|-------------|---------------------|
| `mark_snippet` | Returns `<script>` tag + tracker usage | slug |
| `mark_ingest` | Injects a synthetic event from the agent | tag, entity_id, ts (Unix ms for backdating) |
| `mark_list` | Lists all active slugs with counts | — |
| `mark_summary` | Overview: sessions, events, top events | days, **tag** |
| `mark_funnel` | Conversion through ordered steps | days, **tag** |
| `mark_compare` | Before vs after a date pivot | event, days_before, days_after, **tag** |
| `mark_friction` | Where sessions stop progressing | days, **tag** |
| `mark_journey` | Full event sequence for one entity | days |
| `mark_purge` | Delete all data for a slug | — |

## Segmentation with `tag`

Use `tag` to split events into groups — for A/B tests, device types, user tiers, etc.

**Browser side:** call `markjs.setTag('variant-a')` once, all subsequent events carry that tag.

**Agent side:** pass `tag` in `mark_ingest`.

**Reading segmented data:**
```
mark_funnel("slug", ["step_1", "step_2", "purchase"], 30, "variant-a")
mark_funnel("slug", ["step_1", "step_2", "purchase"], 30, "variant-b")
// Compare rates[] to evaluate the variant impact
```

All analysis tools accept a `tag` filter: `mark_summary`, `mark_funnel`, `mark_compare`, `mark_friction`.

## Entity tracking with `entity_id`

`entity_id` links events to a persistent identity across sessions (a user ID, a lead ID, a form submission ID).

**Set it in the browser:**
```js
markjs.identify('lead-456')  // all events from this session are linked to lead-456
```

**Set it via agent:**
```
mark_ingest("slug", "session-abc", "purchase", {plan:"pro"}, tag=null, entity_id="lead-456")
```

**Read the journey:**
```
mark_journey("slug", "lead-456", 30)
→ { total_events: 7, events: [{ ts, event_name, session_id, properties, tag }] }
```

Use `mark_journey` to debug a specific user's path or to correlate with a CRM record.

## Backdating with `ts`

To replay historical data or seed realistic test events at specific timestamps:
```
mark_ingest("slug", "session-1", "signup_start", {}, ts=1748736000000)
```

`ts` is Unix milliseconds. Omit to use current time.

## Interpret results

**`mark_funnel`** — pass steps in expected completion order:
```
mark_funnel("slug", ["page_view", "signup_start", "signup_complete"])
→ { drop_at: "signup_start", rates: [1.0, 0.43, 0.31] }
```
`drop_at` is where to focus. Rate below 0.5 at step 2+ is a friction signal worth investigating.

**`mark_friction`** — use when you don't know which step is the problem:
```
mark_friction("slug") → ordered by sequence, shows sessions_stopped_here per event
```
Start here for open-ended "why are users dropping off?" questions.

**`mark_compare`** — measure impact of a change:
```
mark_compare("slug", pivot="2026-06-01", event="purchase")
→ { before: { completions: 48 }, after: { completions: 71 }, delta: "+47.9%" }
```
Always specify `event` when measuring a specific completion. Without it, compares total sessions.

**`mark_summary`** — quick health check, use before deeper analysis.

## Chaining with Trail

Trail answers "where did this user come from?". Mark answers "what did they do in the app?".
When both are active: use Trail for attribution, Mark for behavior. Pass the Trail `visitor_id` as the Mark `entity_id` to link attribution and in-app behavior at the individual level.

## Limits

| Field | Max |
|-------|-----|
| slug | 100 chars |
| event_name | 100 chars |
| tag | 100 chars |
| entity_id | 200 chars |
| properties keys | 50 per event |
| property string values | 500 chars |

## Rules

- Always call `mark_list` first if you don't know what slugs exist
- Use `mark_ingest` with realistic `session_id`s to seed test events before real users arrive
- `mark_purge` is irreversible — confirm with user before calling it
- HTTP endpoints (`/q/summary/:slug`, `/q/funnel/:slug?steps=a,b,c&tag=variant-a`, etc.) work for any LLM with function calling
- `GET /q/schema` returns the full endpoint list with params and limits
