#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "node:http";
import { z } from "zod";
import { migrate, insertEvent, listSlugs, summary, funnel, compare, friction, journey, purge, registerSnippet, resolveUrl, listSnippets, LIMITS, } from "./db.js";
const PORT = parseInt(process.env.MARK_PORT ?? "7331", 10);
// --- HTTP tracker script ---
function trackerScript(slug) {
    return `(function(){
  var k='_mark_sid';
  var sid=sessionStorage.getItem(k)||(Math.random().toString(36).slice(2)+Date.now().toString(36));
  sessionStorage.setItem(k,sid);
  var _eid=null,_tag=null;
  function send(evt,props){
    var payload={slug:'${slug}',session_id:sid,event_name:evt,properties:props||{}};
    if(_eid) payload.entity_id=_eid;
    if(_tag) payload.tag=_tag;
    fetch('http://localhost:${PORT}/e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true}).catch(function(){});
  }
  window.markjs={
    identify:function(id){ _eid=id||null; },
    setTag:function(t){ _tag=t||null; },
    track:send
  };
  // auto-track page view
  send('page_view',{title:document.title,url:location.pathname});
  // auto-track button/link clicks
  document.addEventListener('click',function(e){
    var el=e.target.closest('button,a,[role=button],input[type=submit],input[type=button]');
    if(!el) return;
    var label=(el.textContent||el.value||el.getAttribute('aria-label')||'').trim().slice(0,60);
    var tag=el.dataset.markEvent||null;
    send(tag||'click',{label:label||undefined,id:el.id||undefined,tag:el.dataset.markTag||undefined});
  });
  // auto-track form submits
  document.addEventListener('submit',function(e){
    var form=e.target;
    send('form_submit',{id:form.id||undefined,action:form.action||undefined});
  });
  // time on page
  var _start=Date.now();
  window.addEventListener('beforeunload',function(){
    send('page_exit',{seconds:Math.round((Date.now()-_start)/1000)});
  });
})();`;
}
function htmlSnippet(slug) {
    return `<script src="http://localhost:${PORT}/mark.js?slug=${encodeURIComponent(slug)}"></script>`;
}
// --- HTTP server ---
function handleRequest(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, port: PORT }));
        return;
    }
    if (req.method === "GET" && url.pathname === "/mark.js") {
        const slug = url.searchParams.get("slug") ?? "default";
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(200);
        res.end(trackerScript(slug));
        return;
    }
    // --- Query endpoints ---
    if (req.method === "GET" && url.pathname === "/q/list") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(listSlugs()));
        return;
    }
    const summaryMatch = url.pathname.match(/^\/q\/summary\/(.+)$/);
    if (req.method === "GET" && summaryMatch) {
        const slug = decodeURIComponent(summaryMatch[1]);
        const days = parseInt(url.searchParams.get("days") ?? "7", 10);
        const tag = url.searchParams.get("tag") ?? undefined;
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(summary(slug, isNaN(days) ? 7 : days, tag)));
        return;
    }
    const funnelMatch = url.pathname.match(/^\/q\/funnel\/(.+)$/);
    if (req.method === "GET" && funnelMatch) {
        const slug = decodeURIComponent(funnelMatch[1]);
        const stepsParam = url.searchParams.get("steps") ?? "";
        const steps = stepsParam.split(",").map((s) => s.trim()).filter(Boolean);
        const days = parseInt(url.searchParams.get("days") ?? "30", 10);
        const tag = url.searchParams.get("tag") ?? undefined;
        if (steps.length < 2) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "steps param requires at least 2 comma-separated event names" }));
            return;
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(funnel(slug, steps, isNaN(days) ? 30 : days, tag)));
        return;
    }
    const compareMatch = url.pathname.match(/^\/q\/compare\/(.+)$/);
    if (req.method === "GET" && compareMatch) {
        const slug = decodeURIComponent(compareMatch[1]);
        const pivot = url.searchParams.get("pivot") ?? "";
        if (!pivot || isNaN(new Date(pivot).getTime())) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "pivot param required — ISO date e.g. 2026-06-01" }));
            return;
        }
        const event = url.searchParams.get("event") ?? null;
        const daysBefore = parseInt(url.searchParams.get("days_before") ?? "14", 10);
        const daysAfter = parseInt(url.searchParams.get("days_after") ?? "14", 10);
        const tag = url.searchParams.get("tag") ?? undefined;
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(compare(slug, pivot, event, isNaN(daysBefore) ? 14 : daysBefore, isNaN(daysAfter) ? 14 : daysAfter, tag)));
        return;
    }
    const frictionMatch = url.pathname.match(/^\/q\/friction\/(.+)$/);
    if (req.method === "GET" && frictionMatch) {
        const slug = decodeURIComponent(frictionMatch[1]);
        const days = parseInt(url.searchParams.get("days") ?? "30", 10);
        const tag = url.searchParams.get("tag") ?? undefined;
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(friction(slug, isNaN(days) ? 30 : days, tag)));
        return;
    }
    const journeyMatch = url.pathname.match(/^\/q\/journey\/(.+)$/);
    if (req.method === "GET" && journeyMatch) {
        const slug = decodeURIComponent(journeyMatch[1]);
        const entity_id = url.searchParams.get("entity_id") ?? "";
        if (!entity_id) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "entity_id param required" }));
            return;
        }
        const days = parseInt(url.searchParams.get("days") ?? "30", 10);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(journey(slug, entity_id, isNaN(days) ? 30 : days)));
        return;
    }
    if (req.method === "GET" && url.pathname === "/q/schema") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({
            limits: LIMITS,
            endpoints: [
                {
                    method: "POST", path: "/e",
                    body: { slug: "string", session_id: "string", event_name: "string", properties: "object?", tag: "string?", entity_id: "string?", ts: "number? (unix ms)" },
                    description: "Ingest an event",
                },
                { method: "GET", path: "/q/list", description: "List active slugs" },
                { method: "GET", path: "/q/summary/:slug", params: { days: "number (default 7)", tag: "string?" }, description: "Session and event overview" },
                { method: "GET", path: "/q/funnel/:slug", params: { steps: "comma-separated event names (min 2)", days: "number (default 30)", tag: "string?" }, description: "Funnel conversion by step" },
                { method: "GET", path: "/q/compare/:slug", params: { pivot: "ISO date", event: "string?", days_before: "number (default 14)", days_after: "number (default 14)", tag: "string?" }, description: "Compare behavior before vs after a date" },
                { method: "GET", path: "/q/friction/:slug", params: { days: "number (default 30)", tag: "string?" }, description: "Drop-off points by event sequence" },
                { method: "GET", path: "/q/journey/:slug", params: { entity_id: "string (required)", days: "number (default 30)" }, description: "All events for a specific entity" },
            ],
        }));
        return;
    }
    // --- Ingestion ---
    if (req.method === "POST" && url.pathname === "/e") {
        let body = "";
        req.on("data", (chunk) => { body += chunk.toString(); });
        req.on("end", () => {
            try {
                const parsed = JSON.parse(body);
                const { slug, session_id, event_name, properties, tag, entity_id, ts } = parsed;
                if (!slug || !session_id || !event_name) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Missing required fields: slug, session_id, event_name" }));
                    return;
                }
                insertEvent(slug, session_id, event_name, properties ?? {}, tag, entity_id, ts);
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
            }
            catch {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
        });
        return;
    }
    res.writeHead(404);
    res.end("Not found");
}
function startHttpServer() {
    const server = createServer(handleRequest);
    server.listen(PORT, () => {
        process.stderr.write(`[mark] HTTP ingestion server on http://localhost:${PORT}\n`);
    });
    server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            process.stderr.write(`[mark] Port ${PORT} already in use — HTTP ingestion unavailable. Set MARK_PORT to override.\n`);
        }
        else {
            process.stderr.write(`[mark] HTTP server error: ${err.message}\n`);
        }
    });
}
// --- MCP helpers ---
function ok(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function err(message) {
    return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}
// --- MCP server ---
async function main() {
    migrate();
    startHttpServer();
    const server = new McpServer({ name: "mark-mcp-server", version: "0.1.6" });
    server.registerTool("mark_snippet", {
        title: "Get Tracking Snippet",
        description: `Generate the HTML <script> tag to embed in your app for event tracking.
Optionally registers the URL → slug association so it can be retrieved later with mark_resolve.

Paste the returned snippet before </body>. Once loaded:
- window.markjs.track(event_name, props) — record an event
- window.markjs.identify(entityId) — link all subsequent events to an entity (user ID, form ID, etc.)
- window.markjs.setTag(tag) — tag all subsequent events (e.g. "variant-a", "mobile")
Auto-tracking: page_view, clicks on buttons/links, form_submit, page_exit are recorded automatically.

Limits: slug max ${LIMITS.slug_max} chars, event_name max ${LIMITS.event_name_max} chars,
props max ${LIMITS.properties_max_keys} keys, string values max ${LIMITS.property_string_max} chars.

Args:
  - slug (string): Unique identifier for your app or page (e.g. "onboarding", "game-v2")
  - url (string, optional): URL of the site or page being instrumented — registers the URL→slug mapping for future lookup

Returns: { snippet, ingestion_url, usage, registered? }`,
        inputSchema: z.object({
            slug: z.string().min(1).max(100).describe("Unique identifier for the app or page to track"),
            url: z.string().url().optional().describe("URL of the site being instrumented — registers the URL→slug mapping"),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, url }) => {
        const result = {
            snippet: htmlSnippet(slug),
            ingestion_url: `http://localhost:${PORT}/e`,
            usage: {
                track: `markjs.track('event_name', { optional: 'props' })`,
                identify: `markjs.identify('user-123') — link events to an entity`,
                setTag: `markjs.setTag('variant-a') — tag events for segmentation`,
            },
        };
        if (url) {
            const reg = registerSnippet(url, slug);
            result.registered = reg;
        }
        return ok(result);
    });
    server.registerTool("mark_resolve", {
        title: "Resolve URL to Slug",
        description: `Look up the slug registered for a given URL.
Use before instrumenting a site to check if it's already been set up, and retrieve the correct slug.

Args:
  - url (string): URL to look up (exact match after normalization — trailing slash ignored, fragment ignored)

Returns: { url, slug, created_at } if found, or { found: false } if no snippet is registered for this URL.

Use when: you're about to instrument a site and want to know if a slug already exists for it.
Complement with mark_list_snippets to see all registered URLs.`,
        inputSchema: z.object({
            url: z.string().min(1).describe("URL to look up"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ url }) => {
        const row = resolveUrl(url);
        return ok(row ?? { found: false, url });
    });
    server.registerTool("mark_list_snippets", {
        title: "List Registered Snippets",
        description: `List all URL→slug registrations, ordered by most recently created.

Returns: Array of { url, slug, created_at }

Use when: you want to see which sites have been instrumented and which slug each one uses.`,
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => ok(listSnippets()));
    server.registerTool("mark_ingest", {
        title: "Inject Event",
        description: `Inject a synthetic event directly from the agent. Useful for testing, seeding, or recording agent-side actions.

Args:
  - slug (string): Identifier of the app or page
  - session_id (string): Unique session identifier
  - event_name (string): Event name — same vocabulary as your instrumentation
  - properties (object, optional): Key-value metadata. Max ${LIMITS.properties_max_keys} keys, strings max ${LIMITS.property_string_max} chars.
  - tag (string, optional): Segment label (e.g. "variant-a", "mobile"). Max ${LIMITS.tag_max} chars.
  - entity_id (string, optional): Persistent entity identifier (user ID, form ID). Max ${LIMITS.entity_id_max} chars.
  - ts (number, optional): Custom timestamp as Unix ms — use to backdate or replay historical events.

Returns: { ok: true, slug, event_name }`,
        inputSchema: z.object({
            slug: z.string().min(1).max(100).describe("App or page identifier"),
            session_id: z.string().min(1).describe("Unique session identifier"),
            event_name: z.string().min(1).max(100).describe("Event name"),
            properties: z.record(z.unknown()).optional().describe("Optional key-value metadata"),
            tag: z.string().max(100).optional().describe("Segment label for A/B testing or filtering"),
            entity_id: z.string().max(200).optional().describe("Persistent entity ID (user, form, etc.) — links events across sessions"),
            ts: z.number().int().positive().optional().describe("Custom timestamp as Unix milliseconds — omit to use current time"),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ slug, session_id, event_name, properties, tag, entity_id, ts }) => {
        try {
            insertEvent(slug, session_id, event_name, (properties ?? {}), tag, entity_id, ts);
            return ok({ ok: true, slug, event_name });
        }
        catch (e) {
            return err(e instanceof Error ? e.message : String(e));
        }
    });
    server.registerTool("mark_list", {
        title: "List Active Slugs",
        description: `List all slugs that have recorded events, with session and event counts.

Returns: Array of { slug, sessions, events, last_event_ts }

Use when: you want to see what apps are currently being tracked before deeper analysis.`,
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => ok(listSlugs()));
    server.registerTool("mark_summary", {
        title: "Get App Summary",
        description: `High-level overview of a slug: total sessions, event count, and top events by frequency.

Args:
  - slug (string): App or page identifier
  - days (number, optional): Lookback window in days (default 7, max 365)
  - tag (string, optional): Filter to events with this tag only — useful for comparing segments

Returns: { slug, period, sessions, events, top_events[], tag? }

Use when: you want a quick health check. Call mark_friction or mark_funnel for deeper analysis.`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            days: z.number().int().min(1).max(365).optional().default(7).describe("Lookback window in days (default 7)"),
            tag: z.string().max(100).optional().describe("Filter to events with this tag only"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, days, tag }) => ok(summary(slug, days ?? 7, tag)));
    server.registerTool("mark_funnel", {
        title: "Measure Funnel Conversion",
        description: `Measure conversion through an ordered list of events. The agent defines the funnel steps.

Args:
  - slug (string): App or page identifier
  - steps (string[]): Ordered event names forming the funnel (min 2 steps)
  - days (number, optional): Lookback window in days (default 30)
  - tag (string, optional): Filter to a specific segment — e.g. compare "variant-a" vs "variant-b" by calling twice

Returns: { slug, steps, counts[], rates[], drop_at, tag? }
  - rates[]: conversion rate vs step 0 (0.0–1.0)
  - drop_at: step with the largest absolute drop-off

Examples:
  - mark_funnel("onboarding", ["page_view", "signup_start", "signup_complete"])
  - mark_funnel("checkout", ["add_to_cart", "checkout_start", "purchase"], 30, "variant-a")`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            steps: z.array(z.string().min(1)).min(2).describe("Ordered list of event names"),
            days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
            tag: z.string().max(100).optional().describe("Filter to a specific segment (e.g. 'variant-a')"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, steps, days, tag }) => ok(funnel(slug, steps, days ?? 30, tag)));
    server.registerTool("mark_compare", {
        title: "Compare Before vs After",
        description: `Compare behavior before and after a date pivot. Measures impact of a change.

Args:
  - slug (string): App or page identifier
  - pivot (string): ISO date string as boundary (e.g. "2026-06-01")
  - event (string, optional): If provided, compares completion rate for this event; otherwise compares session counts
  - days_before (number, optional): Days to include before the pivot (default 14)
  - days_after (number, optional): Days to include after the pivot (default 14)
  - tag (string, optional): Filter to a specific segment

Returns: { before, after, delta, metric, tag? }
  - delta: e.g. "+47.9%" or "-12.3%"

Use when: you shipped a redesign, copy change, or fix and want to measure the behavioral impact.`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            pivot: z.string().describe("ISO date string as comparison boundary (e.g. \"2026-06-01\")"),
            event: z.string().optional().describe("Compare completion rate for this event; otherwise compares session counts"),
            days_before: z.number().int().min(1).max(180).optional().default(14).describe("Days before the pivot (default 14)"),
            days_after: z.number().int().min(1).max(180).optional().default(14).describe("Days after the pivot (default 14)"),
            tag: z.string().max(100).optional().describe("Filter to a specific segment"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, pivot, event, days_before, days_after, tag }) => {
        if (isNaN(new Date(pivot).getTime())) {
            return err(`Invalid pivot date "${pivot}". Use ISO format e.g. "2026-06-01".`);
        }
        return ok(compare(slug, pivot, event ?? null, days_before ?? 14, days_after ?? 14, tag));
    });
    server.registerTool("mark_friction", {
        title: "Find Drop-off Points",
        description: `Identify where users stop progressing. Events ordered by average occurrence time, each step shows sessions that stopped there.

Args:
  - slug (string): App or page identifier
  - days (number, optional): Lookback window in days (default 30)
  - tag (string, optional): Filter to a specific segment

Returns: { slug, total_sessions, drop_events[], tag? }
  - drop_events[]: { event, sessions_reached, sessions_stopped_here, drop_rate }

Use when: you don't know which step is the problem — let Mark surface the friction point.
Then use mark_funnel to zoom in on the suspect step.`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
            tag: z.string().max(100).optional().describe("Filter to a specific segment"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, days, tag }) => ok(friction(slug, days ?? 30, tag)));
    server.registerTool("mark_journey", {
        title: "Get Entity Journey",
        description: `Retrieve all events for a specific entity (user, session group, or any ID you defined with identify()).
Ordered by timestamp — shows the complete behavioral sequence of that entity.

Args:
  - slug (string): App or page identifier
  - entity_id (string): The entity ID passed via markjs.identify() or mark_ingest(entity_id)
  - days (number, optional): Lookback window in days (default 30)

Returns:
  {
    "slug": string,
    "entity_id": string,
    "total_events": number,
    "events": [{ "ts": number, "event_name": string, "session_id": string, "properties": object, "tag": string|null }]
  }

Use when: you want to replay or debug a specific user's path. Complement with mark_funnel for aggregate view.`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            entity_id: z.string().min(1).max(200).describe("Entity ID to retrieve events for"),
            days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, entity_id, days }) => ok(journey(slug, entity_id, days ?? 30)));
    server.registerTool("mark_purge", {
        title: "Purge Slug Data",
        description: `Delete all event data for a slug. Irreversible.

Args:
  - slug (string): Identifier to purge

Returns: { deleted: number }

WARNING: Always confirm with the user before calling this. Data cannot be recovered.`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("Identifier to purge — all events deleted"),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ slug }) => {
        try {
            return ok(purge(slug));
        }
        catch (e) {
            return err(e instanceof Error ? e.message : String(e));
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("[mark] MCP server connected via stdio\n");
}
main().catch((e) => {
    process.stderr.write(`[mark] Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map