import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  throw new Error("[mark] DATABASE_URL is required. Set it to your PostgreSQL connection string.");
}

const sql = postgres(process.env.DATABASE_URL, { max: 10 });

export { sql };

// --- Types ---

export interface EventRow {
  slug: string;
  sessions: number;
  events: number;
  last_event_ts: number;
}

export interface SummaryResult {
  slug: string;
  period: string;
  sessions: number;
  events: number;
  top_events: Array<{ event: string; count: number }>;
  tag?: string;
}

export interface FunnelResult {
  slug: string;
  steps: string[];
  counts: number[];
  rates: number[];
  drop_at: string | null;
  tag?: string;
}

export interface CompareResult {
  before: { period: string; sessions: number; events: number; completions?: number };
  after: { period: string; sessions: number; events: number; completions?: number };
  delta: string;
  metric: string;
  tag?: string;
}

export interface FrictionItem {
  event: string;
  sessions_reached: number;
  sessions_stopped_here: number;
  drop_rate: string;
}

export interface FrictionResult {
  slug: string;
  total_sessions: number;
  drop_events: FrictionItem[];
  tag?: string;
}

export interface SnippetRow {
  url: string;
  slug: string;
  workspace_id: string;
  created_at: number;
}

export interface JourneyEvent {
  ts: number;
  event_name: string;
  session_id: string;
  properties: Record<string, unknown>;
  tag: string | null;
}

export interface JourneyResult {
  slug: string;
  entity_id: string;
  total_events: number;
  events: JourneyEvent[];
}

export interface RecentEvent {
  ts: number;
  event_name: string;
  session_id: string;
  slug: string;
  tag: string | null;
}

export interface BreakdownItem {
  value: string | null;
  sessions: number;
  events: number;
}

export interface BreakdownResult {
  slug: string;
  event_name: string;
  property: string;
  period: string;
  total_sessions: number;
  breakdown: BreakdownItem[];
  tag?: string;
}

export const LIMITS = {
  slug_max: 100,
  event_name_max: 100,
  tag_max: 100,
  entity_id_max: 200,
  properties_max_keys: 50,
  property_string_max: 500,
};

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    return u.origin + u.pathname.replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
}

// =============================================================================
// MIGRATE
// =============================================================================

export async function migrate(): Promise<void> {
  await sql`
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
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT ''`;
  await sql`CREATE INDEX IF NOT EXISTS idx_workspace ON events(workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_workspace_slug ON events(workspace_id, slug)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_slug ON events(slug)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_slug_event ON events(slug, event_name)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_slug_ts ON events(slug, ts)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_slug_tag ON events(slug, tag)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entity ON events(slug, entity_id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS snippets (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(workspace_id, url)
    )
  `;
  await sql`ALTER TABLE snippets ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT ''`;
  // Drop old unique constraint on url alone if it exists, replace with (workspace_id, url)
  await sql`
    DO $$ BEGIN
      ALTER TABLE snippets DROP CONSTRAINT IF EXISTS snippets_url_key;
    EXCEPTION WHEN others THEN NULL;
    END $$
  `;
}

// =============================================================================
// MUTATIONS
// =============================================================================

export async function insertEvent(
  workspaceId: string,
  slug: string,
  session_id: string,
  event_name: string,
  properties: Record<string, unknown> = {},
  tag?: string | null,
  entity_id?: string | null,
  ts?: number
): Promise<void> {
  await sql`
    INSERT INTO events (workspace_id, slug, session_id, event_name, properties, ts, tag, entity_id)
    VALUES (${workspaceId}, ${slug}, ${session_id}, ${event_name}, ${properties as never}, ${ts ?? Date.now()}, ${tag ?? null}, ${entity_id ?? null})
  `;
}

export async function purge(workspaceId: string, slug: string): Promise<{ deleted: number }> {
  const result = await sql`
    WITH deleted AS (DELETE FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} RETURNING 1)
    SELECT COUNT(*) AS n FROM deleted
  `;
  return { deleted: Number((result[0] as { n: string }).n) };
}

// =============================================================================
// QUERIES
// =============================================================================

export async function listSlugs(workspaceId: string): Promise<EventRow[]> {
  const rows = await sql`
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
    slug: r.slug as string,
    sessions: Number(r.sessions),
    events: Number(r.events),
    last_event_ts: Number(r.last_event_ts),
  }));
}

export async function summary(workspaceId: string, slug: string, days: number, tag?: string): Promise<SummaryResult> {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;
  const [agg] = await sql`
    SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
    FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
  `;
  const top = await sql`
    SELECT event_name AS event, COUNT(*) AS count
    FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
    GROUP BY event_name ORDER BY count DESC LIMIT 10
  `;
  return {
    slug,
    period: `${days}d`,
    sessions: Number((agg as { sessions: string }).sessions ?? 0),
    events: Number((agg as { events: string }).events ?? 0),
    top_events: top.map(r => ({ event: r.event as string, count: Number(r.count) })),
    ...(tag ? { tag } : {}),
  };
}

export async function funnel(workspaceId: string, slug: string, steps: string[], days: number, tag?: string): Promise<FunnelResult> {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;
  const counts: number[] = [];

  for (let i = 0; i < steps.length; i++) {
    const sub = steps.slice(0, i + 1);
    if (sub.length === 1) {
      const [row] = await sql`
        SELECT COUNT(DISTINCT session_id) AS n FROM events
        WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND event_name = ${sub[0]} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
      `;
      counts.push(Number((row as { n: string }).n ?? 0));
    } else {
      const [row] = await sql`
        SELECT COUNT(*) AS n FROM (
          SELECT session_id FROM events
          WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND event_name = ANY(${sub}) AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
          GROUP BY session_id HAVING COUNT(DISTINCT event_name) = ${sub.length}
        ) sub
      `;
      counts.push(Number((row as { n: string }).n ?? 0));
    }
  }

  const first = counts[0] ?? 0;
  const rates = counts.map((c, i) => i === 0 ? 1.0 : first === 0 ? 0 : parseFloat((c / first).toFixed(3)));
  let drop_at: string | null = null;
  let maxDrop = 0;
  for (let i = 1; i < counts.length; i++) {
    const drop = (counts[i - 1] ?? 0) - (counts[i] ?? 0);
    if (drop > maxDrop) { maxDrop = drop; drop_at = steps[i] ?? null; }
  }
  return { slug, steps, counts, rates, drop_at, ...(tag ? { tag } : {}) };
}

export async function compare(
  workspaceId: string,
  slug: string, pivot: string, event: string | null,
  daysBefore: number, daysAfter: number, tag?: string
): Promise<CompareResult> {
  const pivotTs = new Date(pivot).getTime();
  const t = tag ?? null;

  const getStats = async (from: number, to: number) => {
    const [base] = await sql`
      SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
      FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${from} AND ts < ${to} AND (${t}::text IS NULL OR tag = ${t})
    `;
    const sessions = Number((base as { sessions: string }).sessions ?? 0);
    const events = Number((base as { events: string }).events ?? 0);
    if (event) {
      const [comp] = await sql`
        SELECT COUNT(DISTINCT session_id) AS completions
        FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND event_name = ${event} AND ts >= ${from} AND ts < ${to} AND (${t}::text IS NULL OR tag = ${t})
      `;
      return { sessions, events, completions: Number((comp as { completions: string }).completions ?? 0) };
    }
    return { sessions, events };
  };

  const before = await getStats(pivotTs - daysBefore * 86_400_000, pivotTs);
  const after = await getStats(pivotTs, pivotTs + daysAfter * 86_400_000);
  const metricBefore = event ? (before as { completions: number }).completions : before.sessions;
  const metricAfter = event ? (after as { completions: number }).completions : after.sessions;
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

export async function friction(workspaceId: string, slug: string, days: number, tag?: string): Promise<FrictionResult> {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;
  const [totalRow] = await sql`
    SELECT COUNT(DISTINCT session_id) AS n FROM events
    WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
  `;
  const total = Number((totalRow as { n: string }).n ?? 0);
  const ordered = await sql`
    SELECT event_name, COUNT(DISTINCT session_id) AS reached, AVG(ts) AS avg_ts
    FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
    GROUP BY event_name ORDER BY avg_ts ASC
  `;
  const drops: FrictionItem[] = ordered.map((e, i) => {
    const next = ordered[i + 1];
    const reached = Number(e.reached);
    const stopped = next ? Math.max(0, reached - Number(next.reached)) : 0;
    return {
      event: e.event_name as string,
      sessions_reached: reached,
      sessions_stopped_here: stopped,
      drop_rate: reached > 0 ? `${((stopped / reached) * 100).toFixed(1)}%` : "0%",
    };
  });
  return { slug, total_sessions: total, drop_events: drops, ...(tag ? { tag } : {}) };
}

export async function journey(workspaceId: string, slug: string, entity_id: string, days: number): Promise<JourneyResult> {
  const since = Date.now() - days * 86_400_000;
  const rows = await sql`
    SELECT ts, event_name, session_id, properties, tag
    FROM events WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND entity_id = ${entity_id} AND ts >= ${since}
    ORDER BY ts ASC
  `;
  const events: JourneyEvent[] = rows.map(r => ({
    ts: Number(r.ts),
    event_name: r.event_name as string,
    session_id: r.session_id as string,
    properties: (r.properties ?? {}) as Record<string, unknown>,
    tag: (r.tag ?? null) as string | null,
  }));
  return { slug, entity_id, total_events: events.length, events };
}

// =============================================================================
// SNIPPETS
// =============================================================================

export async function registerSnippet(workspaceId: string, url: string, slug: string): Promise<SnippetRow> {
  const normalized = normalizeUrl(url);
  const now = Date.now();
  await sql`
    INSERT INTO snippets (workspace_id, url, slug, created_at) VALUES (${workspaceId}, ${normalized}, ${slug}, ${now})
    ON CONFLICT(workspace_id, url) DO UPDATE SET slug = EXCLUDED.slug
  `;
  return { workspace_id: workspaceId, url: normalized, slug, created_at: now };
}

export async function resolveUrl(workspaceId: string, url: string): Promise<SnippetRow | null> {
  const normalized = normalizeUrl(url);
  const [row] = await sql`SELECT workspace_id, url, slug, created_at FROM snippets WHERE workspace_id = ${workspaceId} AND url = ${normalized}`;
  if (!row) return null;
  return { workspace_id: row.workspace_id as string, url: row.url as string, slug: row.slug as string, created_at: Number(row.created_at) };
}

export async function listSnippets(workspaceId: string): Promise<SnippetRow[]> {
  const rows = await sql`SELECT workspace_id, url, slug, created_at FROM snippets WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC`;
  return rows.map(r => ({ workspace_id: r.workspace_id as string, url: r.url as string, slug: r.slug as string, created_at: Number(r.created_at) }));
}

export async function breakdown(
  workspaceId: string,
  slug: string,
  event_name: string,
  property: string,
  days: number,
  tag?: string,
  limit = 30
): Promise<BreakdownResult> {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;
  const [totalRow] = await sql`
    SELECT COUNT(DISTINCT session_id) AS n
    FROM events
    WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND event_name = ${event_name}
      AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
  `;
  const rows = await sql`
    SELECT properties->>${property} AS value,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS events
    FROM events
    WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND event_name = ${event_name}
      AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
    GROUP BY value
    ORDER BY sessions DESC
    LIMIT ${limit}
  `;
  return {
    slug,
    event_name,
    property,
    period: `${days}d`,
    total_sessions: Number((totalRow as { n: string }).n ?? 0),
    breakdown: rows.map(r => ({
      value: (r.value ?? null) as string | null,
      sessions: Number(r.sessions),
      events: Number(r.events),
    })),
    ...(tag ? { tag } : {}),
  };
}

export async function recentEvents(workspaceId: string, limit = 50): Promise<RecentEvent[]> {
  const rows = await sql`
    SELECT ts, event_name, session_id, slug, tag
    FROM events WHERE workspace_id = ${workspaceId}
    ORDER BY ts DESC LIMIT ${limit}
  `;
  return rows.map(r => ({
    ts: Number(r.ts),
    event_name: r.event_name as string,
    session_id: r.session_id as string,
    slug: r.slug as string,
    tag: (r.tag ?? null) as string | null,
  }));
}
