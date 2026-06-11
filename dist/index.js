#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "node:http";
import { z } from "zod";
import { migrate, insertEvent, listSlugs, summary, funnel, compare, friction, purge, } from "./db.js";
const PORT = parseInt(process.env.SPOOR_PORT ?? "7331", 10);
// --- HTTP server for browser event ingestion ---
function trackerScript(slug) {
    return `(function(){
  var k='_spoor_sid';
  var sid=sessionStorage.getItem(k)||(Math.random().toString(36).slice(2)+Date.now().toString(36));
  sessionStorage.setItem(k,sid);
  window.spoor={
    track:function(evt,props){
      fetch('http://localhost:${PORT}/e',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({slug:'${slug}',session_id:sid,event_name:evt,properties:props||{}}),
        keepalive:true
      }).catch(function(){});
    }
  };
})();`;
}
function htmlSnippet(slug) {
    return `<script src="http://localhost:${PORT}/spoor.js?slug=${encodeURIComponent(slug)}"></script>`;
}
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
    if (req.method === "GET" && url.pathname === "/spoor.js") {
        const slug = url.searchParams.get("slug") ?? "default";
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(200);
        res.end(trackerScript(slug));
        return;
    }
    // --- HTTP query endpoints (for local LLMs with function calling) ---
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
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(summary(slug, isNaN(days) ? 7 : days)));
        return;
    }
    const funnelMatch = url.pathname.match(/^\/q\/funnel\/(.+)$/);
    if (req.method === "GET" && funnelMatch) {
        const slug = decodeURIComponent(funnelMatch[1]);
        const stepsParam = url.searchParams.get("steps") ?? "";
        const steps = stepsParam.split(",").map((s) => s.trim()).filter(Boolean);
        const days = parseInt(url.searchParams.get("days") ?? "30", 10);
        if (steps.length < 2) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "steps param requires at least 2 comma-separated event names" }));
            return;
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(funnel(slug, steps, isNaN(days) ? 30 : days)));
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
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(compare(slug, pivot, event, isNaN(daysBefore) ? 14 : daysBefore, isNaN(daysAfter) ? 14 : daysAfter)));
        return;
    }
    const frictionMatch = url.pathname.match(/^\/q\/friction\/(.+)$/);
    if (req.method === "GET" && frictionMatch) {
        const slug = decodeURIComponent(frictionMatch[1]);
        const days = parseInt(url.searchParams.get("days") ?? "30", 10);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(friction(slug, isNaN(days) ? 30 : days)));
        return;
    }
    if (req.method === "GET" && url.pathname === "/q/schema") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({
            endpoints: [
                { method: "POST", path: "/e", body: { slug: "string", session_id: "string", event_name: "string", properties: "object?" }, description: "Ingest an event" },
                { method: "GET", path: "/q/list", description: "List active slugs" },
                { method: "GET", path: "/q/summary/:slug", params: { days: "number (default 7)" }, description: "Session and event overview" },
                { method: "GET", path: "/q/funnel/:slug", params: { steps: "comma-separated event names (min 2)", days: "number (default 30)" }, description: "Funnel conversion by step" },
                { method: "GET", path: "/q/compare/:slug", params: { pivot: "ISO date", event: "string?", days_before: "number (default 14)", days_after: "number (default 14)" }, description: "Compare behavior before vs after a date" },
                { method: "GET", path: "/q/friction/:slug", params: { days: "number (default 30)" }, description: "Drop-off points by event sequence" },
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
                const { slug, session_id, event_name, properties } = JSON.parse(body);
                if (!slug || !session_id || !event_name) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Missing required fields: slug, session_id, event_name" }));
                    return;
                }
                insertEvent(slug, session_id, event_name, properties ?? {});
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
            process.stderr.write(`[mark] Port ${PORT} already in use — HTTP ingestion unavailable. Set SPOOR_PORT to override.\n`);
        }
        else {
            process.stderr.write(`[mark] HTTP server error: ${err.message}\n`);
        }
    });
}
// --- MCP server ---
function ok(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function err(message) {
    return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}
async function main() {
    migrate();
    startHttpServer();
    const server = new McpServer({ name: "mark-mcp-server", version: "0.1.0" });
    server.registerTool("spoor_snippet", {
        title: "Get Tracking Snippet",
        description: `Generate the HTML <script> tag to embed in your app for event tracking.

Paste the returned snippet before </body>. Once loaded, call window.spoor.track(event_name, properties)
anywhere in your JS to record events. The agent defines all event names — no schema is predefined.

Args:
  - slug (string): Unique identifier for your app or page (e.g. "onboarding", "game-v2")

Returns:
  {
    "snippet": string,       // <script> tag to paste into your HTML
    "ingestion_url": string, // Direct POST endpoint for programmatic ingestion
    "usage": string          // Usage example for window.spoor.track
  }

Examples:
  - Use when: you just built a new app and want to observe user behavior
  - Use when: you want to instrument a specific page or flow`,
        inputSchema: z.object({
            slug: z.string().min(1).max(100).describe("Unique identifier for the app or page to track"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug }) => {
        return ok({
            snippet: htmlSnippet(slug),
            ingestion_url: `http://localhost:${PORT}/e`,
            usage: `spoor.track('event_name', { optional: 'properties' })`,
        });
    });
    server.registerTool("spoor_ingest", {
        title: "Inject Event",
        description: `Inject a synthetic event directly from the agent. Useful for testing, seeding, or recording agent-side actions.

Args:
  - slug (string): Identifier of the app or page
  - session_id (string): Unique session identifier (use a stable ID per user session)
  - event_name (string): Name of the event — use the same names you defined when instrumenting
  - properties (object, optional): Key-value metadata for the event

Returns: { ok: true, slug, event_name }

Examples:
  - Use when: testing the funnel before real users exist
  - Use when: recording agent actions alongside user events`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            session_id: z.string().min(1).describe("Unique session identifier"),
            event_name: z.string().min(1).describe("Event name (same vocabulary used in your instrumentation)"),
            properties: z.record(z.unknown()).optional().describe("Optional key-value metadata"),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ slug, session_id, event_name, properties }) => {
        try {
            insertEvent(slug, session_id, event_name, (properties ?? {}));
            return ok({ ok: true, slug, event_name });
        }
        catch (e) {
            return err(e instanceof Error ? e.message : String(e));
        }
    });
    server.registerTool("spoor_list", {
        title: "List Active Slugs",
        description: `List all slugs that have recorded events, with session and event counts.

Returns: Array of { slug, sessions, events, last_event_ts }

Use when: you want to see what apps are currently being tracked.`,
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => ok(listSlugs()));
    server.registerTool("spoor_summary", {
        title: "Get App Summary",
        description: `Get a high-level overview of a slug: total sessions, event count, and top events by frequency.

Args:
  - slug (string): App or page identifier
  - days (number, optional): Lookback window in days (default: 7, max: 365)

Returns:
  {
    "slug": string,
    "period": string,        // e.g. "7d"
    "sessions": number,      // distinct session_id count
    "events": number,        // total event count
    "top_events": [{ "event": string, "count": number }]
  }

Use when: you want a quick health check on an app's usage.`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            days: z.number().int().min(1).max(365).optional().default(7).describe("Lookback window in days (default 7)"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, days }) => ok(summary(slug, days ?? 7)));
    server.registerTool("spoor_funnel", {
        title: "Measure Funnel Conversion",
        description: `Measure conversion through an ordered list of events. The agent defines the funnel steps — pass the event names in the order users are expected to complete them.

Args:
  - slug (string): App or page identifier
  - steps (string[]): Ordered list of event names forming the funnel (min 2 steps)
  - days (number, optional): Lookback window in days (default: 30)

Returns:
  {
    "slug": string,
    "steps": string[],       // The steps you passed in
    "counts": number[],      // Sessions that reached each step
    "rates": number[],       // Conversion rate vs step 0 (0.0–1.0)
    "drop_at": string|null   // Step with the largest absolute drop-off
  }

Examples:
  - spoor_funnel("onboarding", ["page_view", "signup_start", "signup_complete"])
  - spoor_funnel("checkout", ["add_to_cart", "checkout_start", "payment_entered", "purchase"])

Use when: you want to identify where users abandon a multi-step flow.`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            steps: z.array(z.string().min(1)).min(2).describe("Ordered list of event names forming the funnel"),
            days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, steps, days }) => ok(funnel(slug, steps, days ?? 30)));
    server.registerTool("spoor_compare", {
        title: "Compare Before vs After",
        description: `Compare behavior before and after a date pivot. Useful for measuring the impact of a change.

Args:
  - slug (string): App or page identifier
  - pivot (string): ISO date string used as the boundary (e.g. "2026-06-01")
  - event (string, optional): If provided, compares completion rate for this specific event. Otherwise compares session counts.
  - days_before (number, optional): Days to include before the pivot (default 14)
  - days_after (number, optional): Days to include after the pivot (default 14)

Returns:
  {
    "before": { "period": string, "sessions": number, "events": number, "completions"?: number },
    "after":  { "period": string, "sessions": number, "events": number, "completions"?: number },
    "delta": string,   // e.g. "+47.9%" or "-12.3%"
    "metric": string   // What was compared (sessions or completions of event X)
  }

Examples:
  - Use when: you shipped a redesign and want to know if completion improved
  - Use when: you want to compare engagement before and after a copy change`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            pivot: z.string().describe("ISO date string as comparison boundary (e.g. \"2026-06-01\")"),
            event: z.string().optional().describe("If provided, compares completion rate for this event; otherwise compares session counts"),
            days_before: z.number().int().min(1).max(180).optional().default(14).describe("Days before the pivot (default 14)"),
            days_after: z.number().int().min(1).max(180).optional().default(14).describe("Days after the pivot (default 14)"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, pivot, event, days_before, days_after }) => {
        if (isNaN(new Date(pivot).getTime())) {
            return err(`Invalid pivot date "${pivot}". Use ISO format e.g. "2026-06-01".`);
        }
        return ok(compare(slug, pivot, event ?? null, days_before ?? 14, days_after ?? 14));
    });
    server.registerTool("spoor_friction", {
        title: "Find Drop-off Points",
        description: `Identify where users stop progressing. Events are ordered by their average occurrence time, then each step shows how many sessions stopped there.

Args:
  - slug (string): App or page identifier
  - days (number, optional): Lookback window in days (default: 30)

Returns:
  {
    "slug": string,
    "total_sessions": number,
    "drop_events": [
      {
        "event": string,
        "sessions_reached": number,
        "sessions_stopped_here": number,
        "drop_rate": string        // e.g. "34.2%"
      }
    ]
  }

Use when: you don't know which step of a flow to investigate — let Spoor surface the friction point.
Complement with spoor_funnel once you've identified the suspect step.`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("App or page identifier"),
            days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ slug, days }) => ok(friction(slug, days ?? 30)));
    server.registerTool("spoor_purge", {
        title: "Purge Slug Data",
        description: `Delete all event data for a slug. Irreversible — use only to reset a slug during development or testing.

Args:
  - slug (string): Identifier to purge

Returns: { deleted: number }  — number of rows deleted`,
        inputSchema: z.object({
            slug: z.string().min(1).describe("Identifier to purge — all events for this slug will be deleted"),
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