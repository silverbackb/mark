# @silverbackbase/mark · v0.2.0

Headless micro-analytics for AI agents. A one-line snippet on your site, and your agent reads visitor behavior directly — no dashboard, no UI.

Part of [SilverBackBase](https://silverbackbase.com) — a library of agent-first primitives for AI-powered marketing and product work.

---

## How it works

Mark has two surfaces:

- **HTTP server** — accepts events from any browser via a one-line JS snippet, and exposes query endpoints for agents or any LLM with function calling
- **MCP stdio** — exposes tools for Claude Code, Codex CLI, and Claude Desktop

Data is stored in PostgreSQL. Every event is scoped to a `workspace_id` — a string you choose freely (e.g. `"local"`, `"my-project"`) — and to a `project_id`, the client or site this event belongs to.

Both are resolved server-side from the request's domain (`Origin`/`Referer`), matched against a `url` registered via `POST /register` (or the `mark_snippet` MCP tool, which calls it for you). The `<script>` tag never embeds an identifier: it is strictly identical for every client and never needs to change, even if you rename or re-register a site.

---

## Quick start

### 1. Requirements

- Node.js 18+
- PostgreSQL database

### 2. Start the server

```bash
npx -y @silverbackbase/mark
```

Or install globally:

```bash
npm install -g @silverbackbase/mark
mark
```

The server starts on the port defined by `PORT` (default 7331). Migrations run automatically on startup.

### 3. Register your site and add the snippet

Ask your agent (or call the tool directly):

```
mark_snippet(project_id: "my-site", url: "https://my-site.example")
```

This registers the domain → project_id mapping and returns the tag. Paste it before `</body>` on every page:

```html
<script async src="https://your-instance.com/mark.js"></script>
```

The tag is universal — no parameters, works identically pasted directly or injected via a GTM Custom HTML tag.

Once loaded, auto-tracking activates: `page_view`, clicks on buttons/links, `tel_click` (`tel:` links), `form_submit`, `page_exit`, and `scroll_depth` at 25/50/75/100%. Every ingested event is also enriched server-side with `device` (mobile/tablet/desktop), `os` and `browser`, derived from the request User-Agent — group by them with `mark_breakdown`. Custom events:

```js
window.markjs.track('signup_complete', { plan: 'pro' })
window.markjs.identify('user-123')   // link events to an entity
window.markjs.setTag('variant-a')    // tag events for segmentation
```

### 4. Query from the agent

```
mark_funnel("my-site", ["page_view", "scroll_50", "scroll_100"])
// → { drop_at: "scroll_100", rates: [1.0, 0.61, 0.28] }

mark_funnel("my-site", ["page_view", "form_submit", "merci"])
// → { drop_at: "form_submit", rates: [1.0, 0.43, 0.31] }

mark_friction("my-site")
// → where sessions stop, ordered by sequence

mark_compare("my-site", pivot="2026-06-01", event="form_submit")
// → { before: { completions: 48 }, after: { completions: 71 }, delta: "+47.9%" }
```

(`"my-site"` above is shorthand for the `project_id` you passed to `mark_snippet` — every tool below takes `project_id` as its first argument.)

---

## MCP tools

| Tool | Description |
|------|-------------|
| `mark_snippet` | Registers a site's domain and returns the universal `<script>` tag |
| `mark_resolve` | Looks up the client already registered for a URL |
| `mark_list_snippets` | Lists all registered URL → client mappings |
| `mark_ingest` | Injects a synthetic event from the agent (testing, seeding) |
| `mark_list` | Lists all active clients with session and event counts |
| `mark_summary` | Overview: sessions, events, top events over N days |
| `mark_funnel` | Conversion rate through an ordered list of events |
| `mark_compare` | Behavior before vs after a date pivot |
| `mark_friction` | Where sessions stop progressing |
| `mark_journey` | Full event history for a specific entity |
| `mark_breakdown` | Group an event by a property value — e.g. `page_view` by `url` to see top pages |
| `mark_purge` | Delete all data for a client (irreversible) |

---

## HTTP endpoints

```
POST /e                                        Ingest an event (open — called from browsers)
GET  /mark.js                                  Serve the browser tracker script (universal, no params)
GET  /health                                   Health check
GET  /logs/recent?limit=50&project_id=         Recent events, optionally scoped to one client
GET  /q/list                                   List active clients
GET  /q/summary/:project_id?days=7             Session and event overview
GET  /q/funnel/:project_id?steps=a,b,c         Funnel conversion by step
GET  /q/compare/:project_id?pivot=ISO          Before vs after comparison
GET  /q/friction/:project_id                   Drop-off points
GET  /q/journey/:project_id?entity_id=ID       Entity event history
GET  /q/breakdown/:project_id?event=&property= Group event by property value
GET  /q/schema                                 Full endpoint schema
POST /register                                 Register a domain → project_id mapping (authenticated)
```

### Event ingestion payload (`POST /e`)

```json
{
  "session_id": "abc123",
  "event_name": "signup_start",
  "properties": { "optional": "metadata" },
  "tag": "variant-a",
  "entity_id": "user-123"
}
```

The tracker sends nothing that identifies who the event belongs to: `workspace_id` and `project_id` are resolved server-side from the request's `Origin`/`Referer` header, matched against the domain registered via `mark_snippet`/`POST /register`. An event from an unregistered domain is held in a quarantine table rather than dropped or misattributed — register the domain and future events resolve correctly.

Self-hosted only: if the request has no usable `Origin`/`Referer` (a manual `curl` or test script, not a browser), the server falls back to trusting `project_id` from the body directly — there is no multi-tenant registry or billing to protect on a single self-hosted instance.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | HTTP server port (default 7331) |
| `MARK_PUBLIC_URL` | No | Public base URL for snippet generation (default `http://localhost:PORT`) |
| `MARK_WORKSPACE_ID` | No | Workspace ID used by MCP stdio tools (default `"local"`) |
| `MARK_INTERNAL_SECRET` | No | If set, query endpoints (`/q/*`, `/logs/*`, `/register`) require `x-internal-secret: <value>`, and the server treats itself as running in cloud mode (no self-hosted fallback on `POST /e`). Ingestion (`POST /e`) and `/mark.js` remain open either way. |

---

## MCP configuration

### Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "mark": {
      "command": "npx",
      "args": ["-y", "@silverbackbase/mark"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@host/db",
        "MARK_PUBLIC_URL": "https://your-instance.com",
        "MARK_WORKSPACE_ID": "local"
      }
    }
  }
}
```

### Claude Desktop

Same config in `~/Library/Application Support/Claude/claude_desktop_config.json`.

---

## Anti-adblock (optional)

Ad blockers may block requests to `mark.silverbackbase.com`. To proxy through your own domain, add a rewrite rule in your Next.js config:

```js
// next.config.js
rewrites: async () => [
  {
    source: "/m/:path*",
    destination: "https://your-instance.com/:path*",
  },
]
```

Then update your snippet to use `/m/mark.js` and `/m/e` as the ingestion endpoint.

---

## Part of SilverBackBase

Related primitives: [Trail](https://silverbackbase.com) (multi-touch attribution), [Range](https://silverbackbase.com) (local SEO position tracking), [Root](https://silverbackbase.com) (business memory).
