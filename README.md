# @silverbackbase/mark

Headless micro-analytics for AI agents. No dashboard. No UI. An agent instruments your app, users interact with it, the agent reads the data and iterates.

```
npm install -g @silverbackbase/mark
```

---

## The problem

When an AI agent builds or iterates on an app, it has no way to observe what users actually do after delivery. It can add console.log, ask a human to test manually, or ignore post-delivery behavior entirely. There is no feedback loop between the app and the agent.

Mark closes that loop.

---

## How it works

Mark runs a local server with two surfaces:

- **HTTP on port 7331** — accepts events from any browser app via a one-line JS snippet, and exposes query endpoints callable by any LLM with function calling
- **MCP stdio** — exposes 8 tools for Claude Code, Codex/Antigravity CLI, and Claude Desktop

Data is stored in `~/.mark/mark.db` (SQLite, WAL mode). No cloud, no auth, no retention policy.

---

## Quick start

### 1. Start the server

```bash
npx @silverbackbase/mark
```

Or install globally and run `mark`. The server starts on port 7331 and the MCP stdio interface is ready.

### 2. Instrument your app

Ask your agent to call `mark_snippet` with a slug. It returns a `<script>` tag to paste before `</body>`:

```html
<script src="http://localhost:7331/mark.js?slug=my-app"></script>
```

Once loaded, call `window.markjs.track()` anywhere in your JS:

```js
window.markjs.track('signup_start')
window.markjs.track('step_2', { method: 'google' })
window.markjs.track('purchase', { plan: 'pro', amount: 49 })
```

The agent defines all event names. No schema, no predefined taxonomy.

### 3. Query from the agent

```
mark_funnel("my-app", ["signup_start", "step_2", "purchase"])
// → { drop_at: "step_2", rates: [1.0, 0.62, 0.31] }

mark_friction("my-app")
// → where sessions stop, ordered by sequence

mark_compare("my-app", pivot="2026-06-01", event="purchase")
// → { before: { completions: 48 }, after: { completions: 71 }, delta: "+47.9%" }
```

---

## MCP tools

| Tool | What it does |
|------|-------------|
| `mark_snippet` | Returns the `<script>` tag to embed in your app |
| `mark_ingest` | Injects a synthetic event from the agent (testing, seeding) |
| `mark_list` | Lists all active slugs with session and event counts |
| `mark_summary` | Overview of a slug: sessions, events, top events |
| `mark_funnel` | Conversion rate through an ordered list of events |
| `mark_compare` | Behavior before vs after a date pivot |
| `mark_friction` | Where sessions stop progressing |
| `mark_purge` | Delete all data for a slug |

---

## HTTP endpoints

For local LLMs with function calling (Ollama, LM Studio, etc.) — no MCP required.

```
POST /e                              Ingest an event
GET  /mark.js?slug=:slug             Serve the browser tracker script
GET  /q/list                         List active slugs
GET  /q/summary/:slug?days=7         Session and event overview
GET  /q/funnel/:slug?steps=a,b,c     Funnel conversion by step
GET  /q/compare/:slug?pivot=ISO      Before vs after comparison
GET  /q/friction/:slug               Drop-off points
GET  /q/schema                       Full endpoint schema (auto-discovery)
```

Event ingestion payload:

```json
{
  "slug": "my-app",
  "session_id": "abc123",
  "event_name": "signup_start",
  "properties": { "optional": "metadata" }
}
```

---

## MCP configuration (Claude Code)

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "mark": {
      "command": "node",
      "args": ["/path/to/mark/dist/index.js"],
      "env": { "MARK_PORT": "7331" }
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "mark": {
      "command": "mark"
    }
  }
}
```

---

## Auto-start on macOS

To keep the HTTP server running at all times (useful when using Mark with local LLMs):

```bash
cat > ~/Library/LaunchAgents/com.silverbackbase.mark.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.silverbackbase.mark</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/@silverbackbase/mark/dist/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.silverbackbase.mark.plist
```

---

## What Mark does not do

- No UI, no dashboard, no graphs
- No user authentication
- No cross-domain tracking
- No named user sessions (anonymous IDs only)
- No guaranteed retention (purge available per slug)
- No predefined event schema

---

## Part of SilverBackBase

Mark is a primitive in the [SilverBackBase](https://silverbackbase.com) ecosystem — a library of agent-first tools for AI-powered marketing and product work.

Related primitives: [Trail](https://silverbackbase.com) (marketing attribution), [Range](https://silverbackbase.com) (local SEO position tracking), [Root](https://silverbackbase.com) (business memory).
