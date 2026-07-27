import postgres from "postgres";
if (!process.env.DATABASE_URL) {
    throw new Error("[mark] DATABASE_URL is required. Set it to your PostgreSQL connection string.");
}
const sql = postgres(process.env.DATABASE_URL, { max: 10 });
export { sql };
export const LIMITS = {
    event_name_max: 100,
    tag_max: 100,
    entity_id_max: 200,
    properties_max_keys: 50,
    property_string_max: 500,
};
// Miroir de normalizeDomain (silverbackbase_website/app/account/_lib/domain.ts) : le domaine
// canonique enregistre via POST /register n'a jamais de "www." (retire a la source cote registre),
// mais l'Origin/Referer reel envoye par un navigateur l'a systematiquement pour les clients reels
// verifies en prod. Sans ce retrait sur le hostname, resolveByUrl ne matchait jamais : la
// resolution par domaine echouait en silence pour tous les clients.
// Bug reel trouve en production le 2026-07-27 : canonicalDomain (registre Root) est toujours
// stocke SANS protocole ("debarras-easy.fr"), alors qu'un en-tete Origin de navigateur en a
// TOUJOURS un ("https://debarras-easy.fr"). `new URL("debarras-easy.fr")` echoue (pas de
// protocole), et l'ancien fallback retournait la chaine brute telle quelle : l'entree stockee
// ("debarras-easy.fr") ne matchait alors plus jamais un Origin normalise ("https://debarras-easy.fr"),
// et l'ingestion du client partait en quarantaine indefiniment malgre un enregistrement reussi.
// Les 3 clients historiques fonctionnaient uniquement parce qu'ils avaient ete enregistres avant
// ce chemin de code (avec le protocole deja present) ; tout NOUVEAU client enregistre via
// mark_snippet en aurait ete affecte.
export function normalizeUrl(url) {
    const trimmed = url.trim();
    try {
        const u = new URL(trimmed);
        const hostname = u.hostname.replace(/^www\./, "");
        return `${u.protocol}//${hostname}${u.port ? `:${u.port}` : ""}${u.pathname.replace(/\/$/, "")}`;
    }
    catch {
        // Pas de protocole analysable : on en suppose un plutot que de stocker une forme qu'aucun
        // Origin reel ne pourra jamais produire. https par defaut, coherent avec tous les sites reels.
        try {
            return normalizeUrl(`https://${trimmed}`);
        }
        catch {
            return trimmed.replace(/\/$/, "");
        }
    }
}
// =============================================================================
// MIGRATE
// =============================================================================
export async function migrate() {
    // slug a disparu du schema (migration terminee le 2026-07-27, voir CLAUDE.md). Une base
    // existante l'a peut-etre encore : sa suppression (colonne + index) est un DDL destructif fait
    // une seule fois, a la main, hors de cette fonction qui tourne a chaque demarrage — un DROP qui
    // echouerait ici mettrait tout le service down, donc l'ingestion down.
    await sql `
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT '',
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
    // project_id : identite du client, resolue server-side par domaine (voir resolveByUrl). Reste
    // nullable : une ligne non attribuable part en quarantaine plutot que de faire echouer l'INSERT.
    await sql `ALTER TABLE events ADD COLUMN IF NOT EXISTS project_id TEXT`;
    await sql `CREATE INDEX IF NOT EXISTS idx_workspace_project ON events(workspace_id, project_id)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_workspace_project_ts ON events(workspace_id, project_id, ts)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_project_event ON events(project_id, event_name)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_project_entity ON events(project_id, entity_id)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_workspace ON events(workspace_id)`;
    await sql `
    CREATE TABLE IF NOT EXISTS snippets (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
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
    // project_id : identite du client proprietaire de ce domaine, resolue par Origin/Referer plutot
    // qu'embarquee dans le snippet. Nullable : peuplee via POST /register, jamais devinee.
    await sql `ALTER TABLE snippets ADD COLUMN IF NOT EXISTS project_id TEXT`;
    // resolveByUrl filtre sur la colonne url seule ; l'index unique existant est compose
    // (workspace_id, url) et ne couvre pas efficacement une recherche par url seule.
    await sql `CREATE INDEX IF NOT EXISTS idx_snippets_url ON snippets(url)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_snippets_project ON snippets(project_id)`;
    // Quarantaine. Un event dont on ne sait pas a qui il appartient n'est ni ecrit dans events (il
    // polluerait un client), ni rejete (il serait perdu) : il atterrit ici, non facturable et absent
    // des lectures, rejouable une fois le domaine enregistre via POST /register. C'est ce qui permet
    // de tenir ensemble les deux exigences contradictoires du chantier : aucun event perdu, et aucun
    // identifiant issu du corps de la requete.
    await sql `
    CREATE TABLE IF NOT EXISTS events_unresolved (
      id BIGSERIAL PRIMARY KEY,
      origin TEXT,
      payload JSONB NOT NULL,
      received_at BIGINT NOT NULL
    )
  `;
    await sql `CREATE INDEX IF NOT EXISTS idx_unresolved_received ON events_unresolved(received_at)`;
}
// =============================================================================
// MUTATIONS
// =============================================================================
export async function insertEvent(workspaceId, session_id, event_name, properties = {}, tag, entity_id, ts, projectId) {
    await sql `
    INSERT INTO events (workspace_id, session_id, event_name, properties, ts, tag, entity_id, project_id)
    VALUES (${workspaceId}, ${session_id}, ${event_name}, ${properties}, ${ts ?? Date.now()}, ${tag ?? null}, ${entity_id ?? null}, ${projectId ?? null})
  `;
}
/**
 * Met en quarantaine un evenement dont le proprietaire n'a pas pu etre resolu server-side.
 *
 * Ni ecrit dans `events` (il polluerait les donnees d'un client), ni rejete (il serait perdu :
 * l'appel du tracker est fire-and-forget, sans retry). Rejouable une fois le domaine enregistre.
 */
export async function insertUnresolvedEvent(origin, payload) {
    await sql `
    INSERT INTO events_unresolved (origin, payload, received_at)
    VALUES (${origin}, ${payload}, ${Date.now()})
  `;
}
export async function purge(workspaceId, projectId) {
    const result = await sql `
    WITH deleted AS (DELETE FROM events WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} RETURNING 1)
    SELECT COUNT(*) AS n FROM deleted
  `;
    return { deleted: Number(result[0].n) };
}
// Nombre de lignes traitees par lot de purge. Borne la duree et l'emprise de chaque DELETE
// individuel : un DELETE de plusieurs millions de lignes verrouillerait la table le temps de
// l'instruction, un DELETE par lots de 5000 rend chaque instruction courte et libere les locks
// entre deux lots.
const PURGE_BATCH_SIZE = 5000;
// Purge d'age, alignee sur le modele Trail (voir code/trail/packages/server/src/index.ts,
// purgeOldTouchpoints) : supprime tous les evenements plus vieux que retentionDays, tous
// workspaces confondus. Bornee par lots (voir PURGE_BATCH_SIZE) plutot qu'un DELETE massif
// unique. FOR UPDATE SKIP LOCKED rend la fonction sure si plusieurs instances la declenchent en
// meme temps : chaque instance saute les lignes deja verrouillees par une autre au lieu
// d'attendre, et deux appels concurrents ou repetes ne font que supprimer un sous-ensemble
// decroissant de lignes deja qualifiees (ts < cutoff), donc idempotent par construction.
export async function purgeOldEvents(retentionDays) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let removed = 0;
    for (;;) {
        const rows = await sql `
      DELETE FROM events
      WHERE id IN (
        SELECT id FROM events WHERE ts < ${cutoff} LIMIT ${PURGE_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      )
      RETURNING 1
    `;
        removed += rows.length;
        if (rows.length < PURGE_BATCH_SIZE)
            break;
    }
    return { removed };
}
// =============================================================================
// QUERIES
// =============================================================================
export async function listProjects(workspaceId) {
    const rows = await sql `
    SELECT project_id,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS events,
           MAX(ts) AS last_event_ts
    FROM events
    WHERE workspace_id = ${workspaceId} AND project_id IS NOT NULL
    GROUP BY project_id
    ORDER BY last_event_ts DESC
  `;
    return rows.map(r => ({
        project_id: r.project_id,
        sessions: Number(r.sessions),
        events: Number(r.events),
        last_event_ts: Number(r.last_event_ts),
    }));
}
export async function summary(workspaceId, projectId, days, tag) {
    const since = Date.now() - days * 86_400_000;
    const t = tag ?? null;
    const [agg] = await sql `
    SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
    FROM events WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
  `;
    const top = await sql `
    SELECT event_name AS event, COUNT(*) AS count
    FROM events WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
    GROUP BY event_name ORDER BY count DESC LIMIT 10
  `;
    return {
        project_id: projectId,
        period: `${days}d`,
        sessions: Number(agg.sessions ?? 0),
        events: Number(agg.events ?? 0),
        top_events: top.map(r => ({ event: r.event, count: Number(r.count) })),
        ...(tag ? { tag } : {}),
    };
}
export async function funnel(workspaceId, projectId, steps, days, tag) {
    const since = Date.now() - days * 86_400_000;
    const t = tag ?? null;
    const counts = [];
    for (let i = 0; i < steps.length; i++) {
        const sub = steps.slice(0, i + 1);
        if (sub.length === 1) {
            const [row] = await sql `
        SELECT COUNT(DISTINCT session_id) AS n FROM events
        WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND event_name = ${sub[0]} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
      `;
            counts.push(Number(row.n ?? 0));
        }
        else {
            const [row] = await sql `
        SELECT COUNT(*) AS n FROM (
          SELECT session_id FROM events
          WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND event_name = ANY(${sub}) AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
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
    return { project_id: projectId, steps, counts, rates, drop_at, ...(tag ? { tag } : {}) };
}
export async function compare(workspaceId, projectId, pivot, event, daysBefore, daysAfter, tag) {
    const pivotTs = new Date(pivot).getTime();
    const t = tag ?? null;
    const getStats = async (from, to) => {
        const [base] = await sql `
      SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
      FROM events WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND ts >= ${from} AND ts < ${to} AND (${t}::text IS NULL OR tag = ${t})
    `;
        const sessions = Number(base.sessions ?? 0);
        const events = Number(base.events ?? 0);
        if (event) {
            const [comp] = await sql `
        SELECT COUNT(DISTINCT session_id) AS completions
        FROM events WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND event_name = ${event} AND ts >= ${from} AND ts < ${to} AND (${t}::text IS NULL OR tag = ${t})
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
export async function friction(workspaceId, projectId, days, tag) {
    const since = Date.now() - days * 86_400_000;
    const t = tag ?? null;
    const [totalRow] = await sql `
    SELECT COUNT(DISTINCT session_id) AS n FROM events
    WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
  `;
    const total = Number(totalRow.n ?? 0);
    const ordered = await sql `
    SELECT event_name, COUNT(DISTINCT session_id) AS reached, AVG(ts) AS avg_ts
    FROM events WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
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
    return { project_id: projectId, total_sessions: total, drop_events: drops, ...(tag ? { tag } : {}) };
}
export async function journey(workspaceId, projectId, entity_id, days) {
    const since = Date.now() - days * 86_400_000;
    const rows = await sql `
    SELECT ts, event_name, session_id, properties, tag
    FROM events WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND entity_id = ${entity_id} AND ts >= ${since}
    ORDER BY ts ASC
  `;
    const events = rows.map(r => ({
        ts: Number(r.ts),
        event_name: r.event_name,
        session_id: r.session_id,
        properties: (r.properties ?? {}),
        tag: (r.tag ?? null),
    }));
    return { project_id: projectId, entity_id, total_events: events.length, events };
}
// =============================================================================
// SNIPPETS
// =============================================================================
export async function registerSnippet(workspaceId, url, projectId) {
    const normalized = normalizeUrl(url);
    const now = Date.now();
    const [row] = await sql `
    INSERT INTO snippets (workspace_id, url, project_id, created_at)
    VALUES (${workspaceId}, ${normalized}, ${projectId}, ${now})
    ON CONFLICT(workspace_id, url) DO UPDATE
      SET project_id = EXCLUDED.project_id
    RETURNING workspace_id, url, project_id, created_at
  `;
    return {
        workspace_id: row.workspace_id,
        url: row.url,
        project_id: (row.project_id ?? null),
        created_at: Number(row.created_at),
    };
}
export async function resolveUrl(workspaceId, url) {
    const normalized = normalizeUrl(url);
    const [row] = await sql `SELECT workspace_id, url, project_id, created_at FROM snippets WHERE workspace_id = ${workspaceId} AND url = ${normalized}`;
    if (!row)
        return null;
    return {
        workspace_id: row.workspace_id,
        url: row.url,
        project_id: (row.project_id ?? null),
        created_at: Number(row.created_at),
    };
}
/**
 * Resout workspace_id (et project_id) a partir d'une URL de site, pour GET /mark.js et
 * l'ingestion. Contrairement a resolveUrl (qui verifie une URL DANS un workspace deja connu),
 * ici le workspace lui-meme est inconnu au depart : c'est exactement le probleme que la
 * resolution par domaine doit resoudre (voir CLAUDE.md, decision d'architecture).
 *
 * Reutilise normalizeUrl (pas de duplication). Contrat : le project_id est enregistre au niveau
 * du domaine (POST /register est appele avec l'URL racine du site, pas une page precise) ; la
 * recherche par URL normalisee exacte est donc suffisante et ne necessite pas de LIKE sur prefixe.
 *
 * Si plusieurs workspaces distincts partagent la meme URL normalisee (ne devrait pas arriver :
 * ce cas n'existe que si deux clients enregistrent litteralement le meme domaine), l'ambiguite
 * est reelle et la fonction echoue vers le vide (null) plutot que de deviner un proprietaire.
 */
export async function resolveByUrl(url) {
    const normalized = normalizeUrl(url);
    const rows = await sql `SELECT workspace_id, project_id FROM snippets WHERE url = ${normalized}`;
    if (rows.length === 0)
        return null;
    const workspaces = new Set(rows.map(r => r.workspace_id));
    if (workspaces.size !== 1)
        return null;
    const withProjectId = rows.find(r => r.project_id != null);
    const projectId = withProjectId ? withProjectId.project_id : null;
    return { workspace_id: [...workspaces][0], project_id: projectId };
}
export async function listSnippets(workspaceId) {
    const rows = await sql `SELECT workspace_id, url, project_id, created_at FROM snippets WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC`;
    return rows.map(r => ({
        workspace_id: r.workspace_id,
        url: r.url,
        project_id: (r.project_id ?? null),
        created_at: Number(r.created_at),
    }));
}
export async function breakdown(workspaceId, projectId, event_name, property, days, tag, limit = 30) {
    const since = Date.now() - days * 86_400_000;
    const t = tag ?? null;
    const [totalRow] = await sql `
    SELECT COUNT(DISTINCT session_id) AS n
    FROM events
    WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND event_name = ${event_name}
      AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
  `;
    const rows = await sql `
    SELECT properties->>${property} AS value,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS events
    FROM events
    WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND event_name = ${event_name}
      AND ts >= ${since} AND (${t}::text IS NULL OR tag = ${t})
    GROUP BY value
    ORDER BY sessions DESC
    LIMIT ${limit}
  `;
    return {
        project_id: projectId,
        event_name,
        property,
        period: `${days}d`,
        total_sessions: Number(totalRow.n ?? 0),
        breakdown: rows.map(r => ({
            value: (r.value ?? null),
            sessions: Number(r.sessions),
            events: Number(r.events),
        })),
        ...(tag ? { tag } : {}),
    };
}
// projectId optionnel : sans lui, la fenetre des N derniers evenements est monopolisee par le
// client le plus actif du workspace et un client calme parait sans donnees. Meme correctif que
// sur Trail (GET /logs/recent, commit cf1a064).
export async function recentEvents(workspaceId, limit = 50, projectId) {
    const scope = projectId ? sql `AND project_id = ${projectId}` : sql ``;
    const rows = await sql `
    SELECT ts, event_name, session_id, project_id, tag
    FROM events WHERE workspace_id = ${workspaceId} ${scope}
    ORDER BY ts DESC LIMIT ${limit}
  `;
    return rows.map(r => ({
        ts: Number(r.ts),
        event_name: r.event_name,
        session_id: r.session_id,
        project_id: (r.project_id ?? ""),
        tag: (r.tag ?? null),
    }));
}
//# sourceMappingURL=db.js.map