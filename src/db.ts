import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".mark");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const db = new Database(join(dir, "mark.db"));
db.pragma("journal_mode = WAL");

export function migrate(): void {
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
  // Safe additions for existing DBs
  try { db.exec(`ALTER TABLE events ADD COLUMN tag TEXT`); } catch {}
  try { db.exec(`ALTER TABLE events ADD COLUMN entity_id TEXT`); } catch {}
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_slug_tag ON events(slug, tag);
    CREATE INDEX IF NOT EXISTS idx_entity ON events(slug, entity_id);
  `);
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

// --- Limits ---
export const LIMITS = {
  slug_max: 100,
  event_name_max: 100,
  tag_max: 100,
  entity_id_max: 200,
  properties_max_keys: 50,
  property_string_max: 500,
};

// --- Mutations ---

export function insertEvent(
  slug: string,
  session_id: string,
  event_name: string,
  properties: Record<string, unknown> = {},
  tag?: string | null,
  entity_id?: string | null,
  ts?: number
): void {
  db.prepare(
    `INSERT INTO events (slug, session_id, event_name, properties, ts, tag, entity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    slug,
    session_id,
    event_name,
    JSON.stringify(properties),
    ts ?? Date.now(),
    tag ?? null,
    entity_id ?? null
  );
}

export function purge(slug: string): { deleted: number } {
  const r = db.prepare(`DELETE FROM events WHERE slug = ?`).run(slug);
  return { deleted: r.changes };
}

// --- Queries ---
// Tag filtering uses (? IS NULL OR tag = ?) so params are always fixed-arity.

export function listSlugs(): EventRow[] {
  return db.prepare(`
    SELECT slug,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS events,
           MAX(ts) AS last_event_ts
    FROM events
    GROUP BY slug
    ORDER BY last_event_ts DESC
  `).all() as EventRow[];
}

export function summary(slug: string, days: number, tag?: string): SummaryResult {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;

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
    slug,
    period: `${days}d`,
    sessions: agg?.sessions ?? 0,
    events: agg?.events ?? 0,
    top_events: top,
    ...(tag ? { tag } : {}),
  };
}

export function funnel(slug: string, steps: string[], days: number, tag?: string): FunnelResult {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;

  const counts: number[] = steps.map((_, i) => {
    const sub = steps.slice(0, i + 1);
    if (sub.length === 1) {
      const row = db.prepare(
        `SELECT COUNT(DISTINCT session_id) AS n FROM events
         WHERE slug = ? AND event_name = ? AND ts >= ? AND (? IS NULL OR tag = ?)`
      ).get(slug, sub[0], since, t, t) as { n: number };
      return row?.n ?? 0;
    }
    const ph = sub.map(() => "?").join(",");
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT session_id FROM events
        WHERE slug = ? AND event_name IN (${ph}) AND ts >= ? AND (? IS NULL OR tag = ?)
        GROUP BY session_id
        HAVING COUNT(DISTINCT event_name) = ?
      )
    `).get(slug, ...sub, since, t, t, sub.length) as { n: number };
    return row?.n ?? 0;
  });

  const first = counts[0] ?? 0;
  const rates = counts.map((c, i) => {
    if (i === 0) return 1.0;
    return first === 0 ? 0 : parseFloat((c / first).toFixed(3));
  });

  let drop_at: string | null = null;
  let maxDrop = 0;
  for (let i = 1; i < counts.length; i++) {
    const drop = (counts[i - 1] ?? 0) - (counts[i] ?? 0);
    if (drop > maxDrop) { maxDrop = drop; drop_at = steps[i] ?? null; }
  }

  return { slug, steps, counts, rates, drop_at, ...(tag ? { tag } : {}) };
}

export function compare(
  slug: string,
  pivot: string,
  event: string | null,
  daysBefore: number,
  daysAfter: number,
  tag?: string
): CompareResult {
  const pivotTs = new Date(pivot).getTime();
  const t = tag ?? null;

  const getStats = (from: number, to: number) => {
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
  };

  const before = getStats(pivotTs - daysBefore * 86_400_000, pivotTs);
  const after = getStats(pivotTs, pivotTs + daysAfter * 86_400_000);

  const metricBefore = event ? (before as { completions: number }).completions : before.sessions;
  const metricAfter = event ? (after as { completions: number }).completions : after.sessions;
  const delta =
    metricBefore === 0
      ? "N/A (no data before pivot)"
      : `${metricAfter >= metricBefore ? "+" : ""}${(((metricAfter - metricBefore) / metricBefore) * 100).toFixed(1)}%`;

  return {
    before: { period: `${daysBefore}d before ${pivot}`, ...before },
    after: { period: `${daysAfter}d after ${pivot}`, ...after },
    delta,
    metric: event ? `completions of "${event}"` : "sessions",
    ...(tag ? { tag } : {}),
  };
}

export function friction(slug: string, days: number, tag?: string): FrictionResult {
  const since = Date.now() - days * 86_400_000;
  const t = tag ?? null;

  const total = (db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM events
     WHERE slug = ? AND ts >= ? AND (? IS NULL OR tag = ?)`
  ).get(slug, since, t, t) as { n: number })?.n ?? 0;

  const ordered = db.prepare(`
    SELECT event_name, COUNT(DISTINCT session_id) AS reached, AVG(ts) AS avg_ts
    FROM events WHERE slug = ? AND ts >= ? AND (? IS NULL OR tag = ?)
    GROUP BY event_name
    ORDER BY avg_ts ASC
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

export function journey(slug: string, entity_id: string, days: number): JourneyResult {
  const since = Date.now() - days * 86_400_000;

  const rows = db.prepare(`
    SELECT ts, event_name, session_id, properties, tag
    FROM events
    WHERE slug = ? AND entity_id = ? AND ts >= ?
    ORDER BY ts ASC
  `).all(slug, entity_id, since) as Array<{
    ts: number; event_name: string; session_id: string; properties: string; tag: string | null;
  }>;

  const events: JourneyEvent[] = rows.map(r => ({
    ts: r.ts,
    event_name: r.event_name,
    session_id: r.session_id,
    properties: JSON.parse(r.properties) as Record<string, unknown>,
    tag: r.tag,
  }));

  return { slug, entity_id, total_events: events.length, events };
}
