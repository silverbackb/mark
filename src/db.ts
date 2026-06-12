import Database from "better-sqlite3";
import postgres from "postgres";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Backend selection ---
// PostgreSQL when DATABASE_URL is set (Railway), SQLite otherwise (local)

const USE_PG = !!process.env.DATABASE_URL;

// --- SQLite setup ---
let _sqliteDb: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_sqliteDb) {
    const dir = process.env.MARK_DB_PATH ?? join(homedir(), ".mark");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _sqliteDb = new Database(join(dir, "mark.db"));
    _sqliteDb.pragma("journal_mode = WAL");
  }
  return _sqliteDb;
}

// --- PostgreSQL setup ---
let _sql: postgres.Sql | null = null;

function getSql(): postgres.Sql {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { max: 10 });
  return _sql;
}

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

export const LIMITS = {
  slug_max: 100,
  event_name_max: 100,
  tag_max: 100,
  entity_id_max: 200,
  properties_max_keys: 50,
  property_string_max: 500,
};

// --- URL normalization ---

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
  if (USE_PG) {
    const sql = getSql();
    await sql`
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        slug TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        properties JSONB NOT NULL DEFAULT '{}',
        tag TEXT,
        entity_id TEXT,
        ts BIGINT NOT NULL
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_slug ON events(slug)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_slug_event ON events(slug, event_name)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_slug_ts ON events(slug, ts)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_slug_tag ON events(slug, tag)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_entity ON events(slug, entity_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS snippets (
        id BIGSERIAL PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `;
  } else {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}',
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_slug ON events(slug);
      CREATE INDEX IF NOT EXISTS idx_slug_event ON events(slug, event_name);
      CREATE INDEX IF NOT EXISTS idx_slug_ts ON events(slug, ts);
    `);
    try { db.exec(`ALTER TABLE events ADD COLUMN tag TEXT`); } catch {}
    try { db.exec(`ALTER TABLE events ADD COLUMN entity_id TEXT`); } catch {}
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_slug_tag ON events(slug, tag);
      CREATE INDEX IF NOT EXISTS idx_entity ON events(slug, entity_id);
      CREATE TABLE IF NOT EXISTS snippets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }
}

// =============================================================================
// MUTATIONS
// =============================================================================

export async function insertEvent(
  slug: string,
  session_id: string,
  event_name: string,
  properties: Record<string, unknown> = {},
  tag?: string | null,
  entity_id?: string | null,
  ts?: number
): Promise<void> {
  const now = ts ?? Date.now();
  if (USE_PG) {
    const sql = getSql();
    await sql`
      INSERT INTO events (slug, session_id, event_name, properties, ts, tag, entity_id)
      VALUES (${slug}, ${session_id}, ${event_name}, ${properties as never}, ${now}, ${tag ?? null}, ${entity_id ?? null})
    `;
  } else {
    getDb().prepare(
      `INSERT INTO events (slug, session_id, event_name, properties, ts, tag, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(slug, session_id, event_name, JSON.stringify(properties), now, tag ?? null, entity_id ?? null);
  }
}

export async function purge(slug: string): Promise<{ deleted: number }> {
  if (USE_PG) {
    const sql = getSql();
    const [row] = await sql`DELETE FROM events WHERE slug = ${slug} RETURNING (SELECT COUNT(*) FROM events WHERE slug = ${slug}) AS n` as Array<{ n: string }>;
    // Simpler: use a CTE
    const result = await sql`WITH deleted AS (DELETE FROM events WHERE slug = ${slug} RETURNING 1) SELECT COUNT(*) AS n FROM deleted`;
    return { deleted: Number((result[0] as { n: string }).n) };
  } else {
    const r = getDb().prepare(`DELETE FROM events WHERE slug = ?`).run(slug);
    return { deleted: r.changes };
  }
}

// =============================================================================
// QUERIES
// =============================================================================

export async function listSlugs(): Promise<EventRow[]> {
  if (USE_PG) {
    const sql = getSql();
    const rows = await sql`
      SELECT slug,
             COUNT(DISTINCT session_id) AS sessions,
             COUNT(*) AS events,
             MAX(ts) AS last_event_ts
      FROM events
      GROUP BY slug
      ORDER BY last_event_ts DESC
    `;
    return rows.map(r => ({
      slug: r.slug as string,
      sessions: Number(r.sessions),
      events: Number(r.events),
      last_event_ts: Number(r.last_event_ts),
    }));
  } else {
    return getDb().prepare(`
      SELECT slug, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events, MAX(ts) AS last_event_ts
      FROM events GROUP BY slug ORDER BY last_event_ts DESC
    `).all() as EventRow[];
  }
}

export async function summary(slug: string, days: number, tag?: string): Promise<SummaryResult> {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;

  if (USE_PG) {
    const sql = getSql();
    const [agg] = await sql`
      SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
      FROM events WHERE slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
    `;
    const top = await sql`
      SELECT event_name AS event, COUNT(*) AS count
      FROM events WHERE slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
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
  } else {
    const db = getDb();
    const agg = db.prepare(`
      SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
      FROM events WHERE slug = ? AND ts >= ? AND (? IS NULL OR tag = ?)
    `).get(slug, since, t, t) as { sessions: number; events: number };
    const top = db.prepare(`
      SELECT event_name AS event, COUNT(*) AS count
      FROM events WHERE slug = ? AND ts >= ? AND (? IS NULL OR tag = ?)
      GROUP BY event_name ORDER BY count DESC LIMIT 10
    `).all(slug, since, t, t) as Array<{ event: string; count: number }>;
    return {
      slug, period: `${days}d`,
      sessions: agg?.sessions ?? 0, events: agg?.events ?? 0,
      top_events: top, ...(tag ? { tag } : {}),
    };
  }
}

export async function funnel(slug: string, steps: string[], days: number, tag?: string): Promise<FunnelResult> {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;

  const counts: number[] = [];

  for (let i = 0; i < steps.length; i++) {
    const sub = steps.slice(0, i + 1);
    if (USE_PG) {
      const sql = getSql();
      let n: number;
      if (sub.length === 1) {
        const [row] = await sql`
          SELECT COUNT(DISTINCT session_id) AS n FROM events
          WHERE slug = ${slug} AND event_name = ${sub[0]} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
        `;
        n = Number((row as { n: string }).n ?? 0);
      } else {
        const [row] = await sql`
          SELECT COUNT(*) AS n FROM (
            SELECT session_id FROM events
            WHERE slug = ${slug} AND event_name = ANY(${sub}) AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
            GROUP BY session_id HAVING COUNT(DISTINCT event_name) = ${sub.length}
          ) sub
        `;
        n = Number((row as { n: string }).n ?? 0);
      }
      counts.push(n);
    } else {
      const db = getDb();
      if (sub.length === 1) {
        const row = db.prepare(
          `SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE slug = ? AND event_name = ? AND ts >= ? AND (? IS NULL OR tag = ?)`
        ).get(slug, sub[0], since, t, t) as { n: number };
        counts.push(row?.n ?? 0);
      } else {
        const ph = sub.map(() => "?").join(",");
        const row = db.prepare(`
          SELECT COUNT(*) AS n FROM (
            SELECT session_id FROM events WHERE slug = ? AND event_name IN (${ph}) AND ts >= ? AND (? IS NULL OR tag = ?)
            GROUP BY session_id HAVING COUNT(DISTINCT event_name) = ?
          )
        `).get(slug, ...sub, since, t, t, sub.length) as { n: number };
        counts.push(row?.n ?? 0);
      }
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
  slug: string, pivot: string, event: string | null,
  daysBefore: number, daysAfter: number, tag?: string
): Promise<CompareResult> {
  const pivotTs = new Date(pivot).getTime();
  const t = tag ?? null;

  const getStats = async (from: number, to: number) => {
    if (USE_PG) {
      const sql = getSql();
      const [base] = await sql`
        SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
        FROM events WHERE slug = ${slug} AND ts >= ${from} AND ts < ${to} AND (${t}::text IS NULL OR tag = ${t})
      `;
      const sessions = Number((base as { sessions: string }).sessions ?? 0);
      const events = Number((base as { events: string }).events ?? 0);
      if (event) {
        const [comp] = await sql`
          SELECT COUNT(DISTINCT session_id) AS completions
          FROM events WHERE slug = ${slug} AND event_name = ${event} AND ts >= ${from} AND ts < ${to} AND (${t}::text IS NULL OR tag = ${t})
        `;
        return { sessions, events, completions: Number((comp as { completions: string }).completions ?? 0) };
      }
      return { sessions, events };
    } else {
      const db = getDb();
      const base = db.prepare(`
        SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
        FROM events WHERE slug = ? AND ts >= ? AND ts < ? AND (? IS NULL OR tag = ?)
      `).get(slug, from, to, t, t) as { sessions: number; events: number };
      if (event) {
        const comp = db.prepare(`
          SELECT COUNT(DISTINCT session_id) AS completions
          FROM events WHERE slug = ? AND event_name = ? AND ts >= ? AND ts < ? AND (? IS NULL OR tag = ?)
        `).get(slug, event, from, to, t, t) as { completions: number };
        return { sessions: base?.sessions ?? 0, events: base?.events ?? 0, completions: comp?.completions ?? 0 };
      }
      return { sessions: base?.sessions ?? 0, events: base?.events ?? 0 };
    }
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

export async function friction(slug: string, days: number, tag?: string): Promise<FrictionResult> {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;

  if (USE_PG) {
    const sql = getSql();
    const [totalRow] = await sql`
      SELECT COUNT(DISTINCT session_id) AS n FROM events
      WHERE slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
    `;
    const total = Number((totalRow as { n: string }).n ?? 0);
    const ordered = await sql`
      SELECT event_name, COUNT(DISTINCT session_id) AS reached, AVG(ts) AS avg_ts
      FROM events WHERE slug = ${slug} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
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
  } else {
    const db = getDb();
    const total = ((db.prepare(
      `SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE slug = ? AND ts >= ? AND (? IS NULL OR tag = ?)`
    ).get(slug, since, t, t) as { n: number })?.n ?? 0);
    const ordered = db.prepare(`
      SELECT event_name, COUNT(DISTINCT session_id) AS reached, AVG(ts) AS avg_ts
      FROM events WHERE slug = ? AND ts >= ? AND (? IS NULL OR tag = ?)
      GROUP BY event_name ORDER BY avg_ts ASC
    `).all(slug, since, t, t) as Array<{ event_name: string; reached: number; avg_ts: number }>;
    const drops: FrictionItem[] = ordered.map((e, i) => {
      const next = ordered[i + 1];
      const stopped = next ? Math.max(0, e.reached - next.reached) : 0;
      return {
        event: e.event_name,
        sessions_reached: e.reached,
        sessions_stopped_here: stopped,
        drop_rate: e.reached > 0 ? `${((stopped / e.reached) * 100).toFixed(1)}%` : "0%",
      };
    });
    return { slug, total_sessions: total, drop_events: drops, ...(tag ? { tag } : {}) };
  }
}

export async function journey(slug: string, entity_id: string, days: number): Promise<JourneyResult> {
  const since = Date.now() - days * 86_400_000;

  if (USE_PG) {
    const sql = getSql();
    const rows = await sql`
      SELECT ts, event_name, session_id, properties, tag
      FROM events WHERE slug = ${slug} AND entity_id = ${entity_id} AND ts >= ${since}
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
  } else {
    const rows = getDb().prepare(`
      SELECT ts, event_name, session_id, properties, tag
      FROM events WHERE slug = ? AND entity_id = ? AND ts >= ? ORDER BY ts ASC
    `).all(slug, entity_id, since) as Array<{ ts: number; event_name: string; session_id: string; properties: string; tag: string | null }>;
    const events: JourneyEvent[] = rows.map(r => ({
      ts: r.ts, event_name: r.event_name, session_id: r.session_id,
      properties: JSON.parse(r.properties) as Record<string, unknown>, tag: r.tag,
    }));
    return { slug, entity_id, total_events: events.length, events };
  }
}

// =============================================================================
// SNIPPETS
// =============================================================================

export async function registerSnippet(url: string, slug: string): Promise<SnippetRow> {
  const normalized = normalizeUrl(url);
  const now = Date.now();
  if (USE_PG) {
    const sql = getSql();
    await sql`
      INSERT INTO snippets (url, slug, created_at) VALUES (${normalized}, ${slug}, ${now})
      ON CONFLICT(url) DO UPDATE SET slug = EXCLUDED.slug
    `;
  } else {
    getDb().prepare(`
      INSERT INTO snippets (url, slug, created_at) VALUES (?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET slug = excluded.slug
    `).run(normalized, slug, now);
  }
  return { url: normalized, slug, created_at: now };
}

export async function resolveUrl(url: string): Promise<SnippetRow | null> {
  const normalized = normalizeUrl(url);
  if (USE_PG) {
    const sql = getSql();
    const [row] = await sql`SELECT url, slug, created_at FROM snippets WHERE url = ${normalized}`;
    if (!row) return null;
    return { url: row.url as string, slug: row.slug as string, created_at: Number(row.created_at) };
  } else {
    return getDb().prepare(`SELECT url, slug, created_at FROM snippets WHERE url = ?`).get(normalized) as SnippetRow | null;
  }
}

export async function listSnippets(): Promise<SnippetRow[]> {
  if (USE_PG) {
    const sql = getSql();
    const rows = await sql`SELECT url, slug, created_at FROM snippets ORDER BY created_at DESC`;
    return rows.map(r => ({ url: r.url as string, slug: r.slug as string, created_at: Number(r.created_at) }));
  } else {
    return getDb().prepare(`SELECT url, slug, created_at FROM snippets ORDER BY created_at DESC`).all() as SnippetRow[];
  }
}
