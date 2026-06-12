# @silverbackbase/mark

Headless micro-analytics for AI agents. A one-line snippet on your site, and your agent reads visitor behavior directly — no dashboard, no UI.

Part of [SilverBackBase](https://silverbackbase.com) — a library of agent-first primitives for AI-powered marketing and product work.

---

## How it works

Mark has two surfaces:

- **HTTP server** — accepts events from any browser via a one-line JS snippet, and exposes query endpoints for agents or any LLM with function calling
- **MCP stdio** — exposes tools for Claude Code, Codex CLI, and Claude Desktop

Data is stored in PostgreSQL. Every event is scoped to a `workspace_id` — a string you choose freely (e.g. `"local"`, `"my-project"`).

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

### 3. Add the snippet to your site

Paste before `</body>` on every page:

```html
<script src="https://your-instance.com/mark.js?slug=my-site&wid=local"></script>
```

`slug` identifies the site. `wid` is your workspace ID — use any consistent string.

Once loaded, auto-tracking activates: `page_view`, clicks on buttons/links, `form_submit`, `page_exit`. Custom events:

```js
window.markjs.track('signup_complete', { plan: 'pro' })
window.markjs.identify('user-123')   // link events to an entity
window.markjs.setTag('variant-a')    // tag events for segmentation
```

### 4. Query from the agent

```
mark_funnel("my-site", ["page_view", "form_submit", "merci"])
// → { drop_at: "form_submit", rates: [1.0, 0.43, 0.31] }

mark_friction("my-site")
// → where sessions stop, ordered by sequence

mark_compare("my-site", pivot="2026-06-01", event="form_submit")
// → { before: { completions: 48 }, after: { completions: 71 }, delta: "+47.9%" }
```

---

## MCP tools

| Tool | Description |
|------|-------------|
| `mark_snippet` | Returns the `<script>` tag to embed on the site |
| `mark_ingest` | Injects a synthetic event from the agent (testing, seeding) |
| `mark_list` | Lists all active slugs with session and event counts |
| `mark_summary` | Overview: sessions, events, top events over N days |
| `mark_funnel` | Conversion rate through an ordered list of events |
| `mark_compare` | Behavior before vs after a date pivot |
| `mark_friction` | Where sessions stop progressing |
| `mark_journey` | Full event history for a specific entity |
| `mark_purge` | Delete all data for a slug (irreversible) |

---

## HTTP endpoints

```
POST /e                                  Ingest an event (open — called from browsers)
GET  /mark.js?slug=:slug&wid=:wid        Serve the browser tracker script
GET  /health                             Health check
GET  /logs/recent?limit=50               Recent events
GET  /q/list                             List active slugs
GET  /q/summary/:slug?days=7             Session and event overview
GET  /q/funnel/:slug?steps=a,b,c         Funnel conversion by step
GET  /q/compare/:slug?pivot=ISO          Before vs after comparison
GET  /q/friction/:slug                   Drop-off points
GET  /q/journey/:slug?entity_id=ID       Entity event history
GET  /q/schema                           Full endpoint schema
```

### Event ingestion payload (`POST /e`)

```json
{
  "workspace_id": "local",
  "slug": "my-site",
  "session_id": "abc123",
  "event_name": "signup_start",
  "properties": { "optional": "metadata" },
  "tag": "variant-a",
  "entity_id": "user-123"
}
```

`workspace_id` is required — all data is scoped by it.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | HTTP server port (default 7331) |
| `MARK_PUBLIC_URL` | No | Public base URL for snippet generation (default `http://localhost:PORT`) |
| `MARK_WORKSPACE_ID` | No | Workspace ID used by MCP stdio tools (default `"local"`) |
| `MARK_INTERNAL_SECRET` | No | If set, query endpoints (`/q/*`, `/logs/*`) require `x-internal-secret: <value>`. Ingestion (`POST /e`) and `/mark.js` remain open. |

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
