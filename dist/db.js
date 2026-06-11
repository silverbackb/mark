import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const dir = join(homedir(), ".mark");
if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
const db = new Database(join(dir, "mark.db"));
db.pragma("journal_mode = WAL");
export function migrate() {
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
}
// --- Mutations ---
export function insertEvent(slug, session_id, event_name, properties = {}) {
    db.prepare(`INSERT INTO events (slug, session_id, event_name, properties, ts) VALUES (?, ?, ?, ?, ?)`).run(slug, session_id, event_name, JSON.stringify(properties), Date.now());
}
export function purge(slug) {
    const r = db.prepare(`DELETE FROM events WHERE slug = ?`).run(slug);
    return { deleted: r.changes };
}
// --- Queries ---
export function listSlugs() {
    return db.prepare(`
    SELECT slug,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS events,
           MAX(ts) AS last_event_ts
    FROM events
    GROUP BY slug
    ORDER BY last_event_ts DESC
  `).all();
}
export function summary(slug, days) {
    const since = Date.now() - days * 86_400_000;
    const agg = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
    FROM events WHERE slug = ? AND ts >= ?
  `).get(slug, since);
    const top = db.prepare(`
    SELECT event_name AS event, COUNT(*) AS count
    FROM events WHERE slug = ? AND ts >= ?
    GROUP BY event_name ORDER BY count DESC LIMIT 10
  `).all(slug, since);
    return {
        slug,
        period: `${days}d`,
        sessions: agg?.sessions ?? 0,
        events: agg?.events ?? 0,
        top_events: top,
    };
}
export function funnel(slug, steps, days) {
    const since = Date.now() - days * 86_400_000;
    // Count sessions that have reached each step (cumulative: all steps up to i)
    const counts = steps.map((_, i) => {
        const sub = steps.slice(0, i + 1);
        if (sub.length === 1) {
            const row = db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE slug = ? AND event_name = ? AND ts >= ?`).get(slug, sub[0], since);
            return row?.n ?? 0;
        }
        const ph = sub.map(() => "?").join(",");
        const row = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT session_id FROM events
        WHERE slug = ? AND event_name IN (${ph}) AND ts >= ?
        GROUP BY session_id
        HAVING COUNT(DISTINCT event_name) = ?
      )
    `).get(slug, ...sub, since, sub.length);
        return row?.n ?? 0;
    });
    const first = counts[0] ?? 0;
    const rates = counts.map((c, i) => {
        if (i === 0)
            return 1.0;
        return first === 0 ? 0 : parseFloat((c / first).toFixed(3));
    });
    let drop_at = null;
    let maxDrop = 0;
    for (let i = 1; i < counts.length; i++) {
        const drop = (counts[i - 1] ?? 0) - (counts[i] ?? 0);
        if (drop > maxDrop) {
            maxDrop = drop;
            drop_at = steps[i] ?? null;
        }
    }
    return { slug, steps, counts, rates, drop_at };
}
export function compare(slug, pivot, event, daysBefore, daysAfter) {
    const pivotTs = new Date(pivot).getTime();
    const getStats = (from, to) => {
        const base = db.prepare(`
      SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
      FROM events WHERE slug = ? AND ts >= ? AND ts < ?
    `).get(slug, from, to);
        if (event) {
            const comp = db.prepare(`
        SELECT COUNT(DISTINCT session_id) AS completions
        FROM events WHERE slug = ? AND event_name = ? AND ts >= ? AND ts < ?
      `).get(slug, event, from, to);
            return { sessions: base?.sessions ?? 0, events: base?.events ?? 0, completions: comp?.completions ?? 0 };
        }
        return { sessions: base?.sessions ?? 0, events: base?.events ?? 0 };
    };
    const before = getStats(pivotTs - daysBefore * 86_400_000, pivotTs);
    const after = getStats(pivotTs, pivotTs + daysAfter * 86_400_000);
    const metricBefore = event ? before.completions : before.sessions;
    const metricAfter = event ? after.completions : after.sessions;
    const delta = metricBefore === 0
        ? "N/A (no data before pivot)"
        : `${metricAfter >= metricBefore ? "+" : ""}${(((metricAfter - metricBefore) / metricBefore) * 100).toFixed(1)}%`;
    return {
        before: { period: `${daysBefore}d before ${pivot}`, ...before },
        after: { period: `${daysAfter}d after ${pivot}`, ...after },
        delta,
        metric: event ? `completions of "${event}"` : "sessions",
    };
}
export function friction(slug, days) {
    const since = Date.now() - days * 86_400_000;
    const total = db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE slug = ? AND ts >= ?`).get(slug, since)?.n ?? 0;
    const ordered = db.prepare(`
    SELECT event_name, COUNT(DISTINCT session_id) AS reached, AVG(ts) AS avg_ts
    FROM events WHERE slug = ? AND ts >= ?
    GROUP BY event_name
    ORDER BY avg_ts ASC
  `).all(slug, since);
    const drops = ordered.map((e, i) => {
        const next = ordered[i + 1];
        const stopped = next ? Math.max(0, e.reached - next.reached) : 0;
        return {
            event: e.event_name,
            sessions_reached: e.reached,
            sessions_stopped_here: stopped,
            drop_rate: e.reached > 0 ? `${((stopped / e.reached) * 100).toFixed(1)}%` : "0%",
        };
    });
    return { slug, total_sessions: total, drop_events: drops };
}
//# sourceMappingURL=db.js.map