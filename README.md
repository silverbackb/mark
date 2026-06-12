# @silverbackbase/mark

Headless micro-analytics for AI agents. A one-line snippet on your site, and your agent reads visitor behavior directly — no dashboard, no UI.

Part of [SilverBackBase](https://silverbackbase.com) — a library of agent-first primitives for AI-powered marketing and product work.

---

## How it works

Mark has two surfaces:

- **HTTP server** — accepts events from any browser via a one-line JS snippet, and exposes query endpoints for agents or any LLM with function calling
- **MCP stdio** — exposes tools for Claude Code, Codex CLI, and Claude Desktop

Data is stored in PostgreSQL, isolated by `workspace_id`. Every event is scoped to a workspace.

---

## Self-hosted quick start

### 1. Requirements

- Node.js 18+
- PostgreSQL database (`DATABASE_URL` env var)

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

Paste before `</body>` on every page. Replace `your-workspace-id` with any stable identifier for your workspace:

```html
<script src="https://your-instance.com/mark.js?slug=my-site&wid=your-workspace-id"></script>
```

Once loaded, auto-tracking activates: `page_view`, clicks on buttons/links, `form_submit`, `page_exit`. You can also track custom events:

```js
window.markjs.track('signup_complete', { plan: 'pro' })
window.markjs.identify('user-123')   // link events to an entity
window.markjs.setTag('variant-a')    // tag events for segmentation
```

### 4. Query from the agent

Ask your agent to call `mark_summary`, `mark_funnel`, `mark_friction`, etc. Examples:

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
GET  /logs/recent?limit=50               Recent events (requires x-internal-secret if set)
GET  /q/list                             List active slugs (requires x-internal-secret if set)
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
  "workspace_id": "your-workspace-id",
  "slug": "my-site",
  "session_id": "abc123",
  "event_name": "signup_start",
  "properties": { "optional": "metadata" },
  "tag": "variant-a",
  "entity_id": "user-123"
}
```

`workspace_id` is required — all data is isolated per workspace.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | HTTP server port (default 7331) |
| `MARK_PUBLIC_URL` | No | Public base URL for snippet generation (default `http://localhost:PORT`) |
| `MARK_INTERNAL_SECRET` | No | Secret header required on query endpoints (`/q/*`, `/logs/*`). If empty, query endpoints are open (self-hosted default). |
| `MARK_WORKSPACE_ID` | No | Workspace ID used by MCP stdio tools (default `"local"`) |

---

## MCP configuration (self-hosted)

### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "mark": {
      "command": "npx",
      "args": ["-y", "@silverbackbase/mark"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@host/db",
        "MARK_PUBLIC_URL": "https://your-instance.com",
        "MARK_WORKSPACE_ID": "your-workspace-id"
      }
    }
  }
}
```

---

## Security model

- **Ingestion** (`POST /e`, `/mark.js`): always open — called from visitor browsers, no auth possible.
- **Query endpoints** (`/q/*`, `/logs/*`): protected by `x-internal-secret` header when `MARK_INTERNAL_SECRET` is set. In self-hosted mode with no secret set, query endpoints are open.
- **Data isolation**: every event and snippet is scoped to a `workspace_id`. Queries only return data for the `workspace_id` passed via `x-workspace-id` header.

---

## Part of SilverBackBase

Related primitives: [Trail](https://silverbackbase.com) (multi-touch attribution), [Range](https://silverbackbase.com) (local SEO position tracking), [Root](https://silverbackbase.com) (business memory).
