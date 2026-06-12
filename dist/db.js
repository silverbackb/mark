import postgres from "postgres";
if (!process.env.DATABASE_URL) {
    throw new Error("[mark] DATABASE_URL is required. Set it to your PostgreSQL connection string.");
}
const sql = postgres(process.env.DATABASE_URL, { max: 10 });
export { sql };
export const LIMITS = {
    slug_max: 100,
    event_name_max: 100,
    tag_max: 100,
    entity_id_max: 200,
    properties_max_keys: 50,
    property_string_max: 500,
};
function normalizeUrl(url) {
    try {
        const u = new URL(url.trim());
        return u.origin + u.pathname.replace(/\/$/, "");
    }
    catch {
        return url.trim().replace(/\/$/, "");
    }
}
// =============================================================================
// MIGRATE
// =============================================================================
export async function migrate() {
    await sql `
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      properties JSONB NOT NULL DEFAULT '{}',
      tag TEXT,
      entity_id TEXT,
      ts BIGINT NOT NULL
    )
  `;
    // Add workspace_id to existing tables that were created before this migration
    await sql `ALTER TABLE events ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT ''`;
    await sql `CREATE INDEX IF NOT EXISTS idx_workspace ON events(workspace_id)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_workspace_slug ON events(workspace_id, slug)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_slug ON events(slug)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_slug_event ON events(slug, event_name)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_slug_ts ON events(slug, ts)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_slug_tag ON events(slug, tag)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_entity ON events(slug, entity_id)`;
    await sql `
    CREATE TABLE IF NOT EXISTS snippets (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(workspace_id, url)
    )
  `;
    await sql `ALTER TABLE snippets ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT ''`;
    // Drop old unique constraint on url alone if it exists, replace with (workspace_id, url)
    await sql `
    DO $$ BEGIN
      ALTER TABLE snippets DROP CONSTRAINT IF EXISTS snippets_url_key;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `;
}
// =============================================================================
// MUTATIONS
// =============================================================================
export async function insertEvent(workspaceId, slug, session_id, event_name, properties = {}, tag, entity_id, ts) {
    await sql `
    INSERT INTO events (workspace_id, slug, session_id, event_name, properties, ts, tag, entity_id)
    VALUES (${workspaceId}, ${slug}, ${session_id}, ${event_name}, ${properties}, ${ts ?? Date.now()}, ${tag ?? null}, ${entity_id ?? null})
  `;
}
export async function purge(workspaceId, slug) {
    const result = await sql `
    WITH deleted AS (DELETE FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} RETURNING 1)
    SELECT COUNT(*) AS n FROM deleted
  `;
    return { deleted: Number(result[0].n) };
}
// =============================================================================
// QUERIES
// =============================================================================
export async function listSlugs(workspaceId) {
    const rows = await sql `
    SELECT slug,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS events,
           MAX(ts) AS last_event_ts
    FROM events
    WHERE workspace_id = ${workspaceId}
    GROUP BY slug
    ORDER BY last_event_ts DESC
  `;
    return rows.map(r => ({
        slug: r.slug,
        sessions: Number(r.sessions),
        events: Number(r.events),
        last_event_ts: Number(r.last_event_ts),
    }));
}
export async function summary(workspaceId, slug, days, tag) {
    const since = Date.now() - days * 86_400_000;
    const t = tag ?? null;
    const [agg] = await sql `
    SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
    FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
  `;
    const top = await sql `
    SELECT event_name AS event, COUNT(*) AS count
    FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
    GROUP BY event_name ORDER BY count DESC LIMIT 10
  `;
    return {
        slug,
        period: `${days}d`,
        sessions: Number(agg.sessions ?? 0),
        events: Number(agg.events ?? 0),
        top_events: top.map(r => ({ event: r.event, count: Number(r.count) })),
        ...(tag ? { tag } : {}),
    };
}
export async function funnel(workspaceId, slug, steps, days, tag) {
    const since = Date.now() - days * 86_400_000;
    const t = tag ?? null;
    const counts = [];
    for (let i = 0; i < steps.length; i++) {
        const sub = steps.slice(0, i + 1);
        if (sub.length === 1) {
            const [row] = await sql `
        SELECT COUNT(DISTINCT session_id) AS n FROM events
        WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND event_name = ${sub[0]} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
      `;
            counts.push(Number(row.n ?? 0));
        }
        else {
            const [row] = await sql `
        SELECT COUNT(*) AS n FROM (
          SELECT session_id FROM events
          WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND event_name = ANY(${sub}) AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
          GROUP BY session_id HAVING COUNT(DISTINCT event_name) = ${sub.length}
        ) sub
      `;
            counts.push(Number(row.n ?? 0));
        }
    }
    const first = counts[0] ?? 0;
    const rates = counts.map((c, i) => i === 0 ? 1.0 : first === 0 ? 0 : parseFloat((c / first).toFixed(3)));
    let drop_at = null;
    let maxDrop = 0;
    for (let i = 1; i < counts.length; i++) {
        const drop = (counts[i - 1] ?? 0) - (counts[i] ?? 0);
        if (drop > maxDrop) {
            maxDrop = drop;
            drop_at = steps[i] ?? null;
        }
    }
    return { slug, steps, counts, rates, drop_at, ...(tag ? { tag } : {}) };
}
export async function compare(workspaceId, slug, pivot, event, daysBefore, daysAfter, tag) {
    const pivotTs = new Date(pivot).getTime();
    const t = tag ?? null;
    const getStats = async (from, to) => {
        const [base] = await sql `
      SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
      FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${from} AND ts < ${to} AND (${t}::text IS NULL OR tag = ${t})
    `;
        const sessions = Number(base.sessions ?? 0);
        const events = Number(base.events ?? 0);
        if (event) {
            const [comp] = await sql `
        SELECT COUNT(DISTINCT session_id) AS completions
        FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND event_name = ${event} AND ts >= ${from} AND ts < ${to} AND (${t}::text IS NULL OR tag = ${t})
      `;
            return { sessions, events, completions: Number(comp.completions ?? 0) };
        }
        return { sessions, events };
    };
    const before = await getStats(pivotTs - daysBefore * 86_400_000, pivotTs);
    const after = await getStats(pivotTs, pivotTs + daysAfter * 86_400_000);
    const metricBefore = event ? before.completions : before.sessions;
    const metricAfter = event ? after.completions : after.sessions;
    const delta = metricBefore === 0
        ? "N/A (no data before pivot)"
        : `${metricAfter >= metricBefore ? "+" : ""}${(((metricAfter - metricBefore) / metricBefore) * 100).toFixed(1)}%`;
    return {
        before: { period: `${daysBefore}d before ${pivot}`, ...before },
        after: { period: `${daysAfter}d after ${pivot}`, ...after },
        delta, metric: event ? `completions of "${event}"` : "sessions",
        ...(tag ? { tag } : {}),
    };
}
export async function friction(workspaceId, slug, days, tag) {
    const since = Date.now() - days * 86_400_000;
    const t = tag ?? null;
    const [totalRow] = await sql `
    SELECT COUNT(DISTINCT session_id) AS n FROM events
    WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
  `;
    const total = Number(totalRow.n ?? 0);
    const ordered = await sql `
    SELECT event_name, COUNT(DISTINCT session_id) AS reached, AVG(ts) AS avg_ts
    FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
    GROUP BY event_name ORDER BY avg_ts ASC
  `;
    const drops = ordered.map((e, i) => {
        const next = ordered[i + 1];
        const reached = Number(e.reached);
        const stopped = next ? Math.max(0, reached - Number(next.reached)) : 0;
        return {
            event: e.event_name,
            sessions_reached: reached,
            sessions_stopped_here: stopped,
            drop_rate: reached > 0 ? `${((stopped / reached) * 100).toFixed(1)}%` : "0%",
        };
    });
    return { slug, total_sessions: total, drop_events: drops, ...(tag ? { tag } : {}) };
}
export async function journey(workspaceId, slug, entity_id, days) {
    const since = Date.now() - days * 86_400_000;
    const rows = await sql `
    SELECT ts, event_name, session_id, properties, tag
    FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND entity_id = ${entity_id} AND ts >= ${since}
    ORDER BY ts ASC
  `;
    const events = rows.map(r => ({
        ts: Number(r.ts),
        event_name: r.event_name,
        session_id: r.session_id,
        properties: (r.properties ?? {}),
        tag: (r.tag ?? null),
    }));
    return { slug, entity_id, total_events: events.length, events };
}
// =============================================================================
// SNIPPETS
// =============================================================================
export async function registerSnippet(workspaceId, url, slug) {
    const normalized = normalizeUrl(url);
    const now = Date.now();
    await sql `
    INSERT INTO snippets (workspace_id, url, slug, created_at) VALUES (${workspaceId}, ${normalized}, ${slug}, ${now})
    ON CONFLICT(workspace_id, url) DO UPDATE SET slug = EXCLUDED.slug
  `;
    return { workspace_id: workspaceId, url: normalized, slug, created_at: now };
}
export async function resolveUrl(workspaceId, url) {
    const normalized = normalizeUrl(url);
    const [row] = await sql `SELECT workspace_id, url, slug, created_at FROM snippets WHERE workspace_id = ${workspaceId} AND url = ${normalized}`;
    if (!row)
        return null;
    return { workspace_id: row.workspace_id, url: row.url, slug: row.slug, created_at: Number(row.created_at) };
}
export async function listSnippets(workspaceId) {
    const rows = await sql `SELECT workspace_id, url, slug, created_at FROM snippets WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC`;
    return rows.map(r => ({ workspace_id: r.workspace_id, url: r.url, slug: r.slug, created_at: Number(r.created_at) }));
}
export async function recentEvents(workspaceId, limit = 50) {
    const rows = await sql `
    SELECT ts, event_name, session_id, slug, tag
    FROM events WHERE workspace_id = ${workspaceId}
    ORDER BY ts DESC LIMIT ${limit}
  `;
    return rows.map(r => ({
        ts: Number(r.ts),
        event_name: r.event_name,
        session_id: r.session_id,
        slug: r.slug,
        tag: (r.tag ?? null),
    }));
}
//# sourceMappingURL=db.js.map