---
name: mark-sbb
description: Companion skill for the Mark MCP (@silverbackbase/mark) — headless micro-analytics for AI agents. Guides the agent through instrumenting an app, reading behavioral data, and iterating based on real user behavior. Use when: delivering or iterating on an HTML/JS app, asked to measure user behavior, asked about funnels or drop-off, wanting to compare before/after a change, or when Trail attribution data needs to be paired with in-app behavior.
---

# Mark — Agent Workflow Guide

Mark runs on `http://localhost:7331`. Check it's alive before any operation: `GET /health`.

## When to use Mark

- After delivering an HTML app, game, onboarding, or multi-step form
- Before iterating: read what users actually do, don't guess
- After a change: compare behavior before/after with `mark_compare`
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
When both are active: use Trail for attribution, Mark for behavior. They share `session_id` if you pass the Trail `visitor_id` as the Mark `session_id` at instrumentation time.

## Rules

- Always call `mark_list` first if you don't know what slugs exist
- Use `mark_ingest` to seed test events before real users arrive
- `mark_purge` is irreversible — confirm with user before calling it
- HTTP endpoints (`/q/summary/:slug` etc.) work for any LLM with function calling, no MCP needed
