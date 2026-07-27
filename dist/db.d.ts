import postgres from "postgres";
declare const sql: postgres.Sql<{}>;
export { sql };
export interface EventRow {
    project_id: string;
    sessions: number;
    events: number;
    last_event_ts: number;
}
export interface SummaryResult {
    project_id: string;
    period: string;
    sessions: number;
    events: number;
    top_events: Array<{
        event: string;
        count: number;
    }>;
    tag?: string;
}
export interface FunnelResult {
    project_id: string;
    steps: string[];
    counts: number[];
    rates: number[];
    drop_at: string | null;
    tag?: string;
}
export interface CompareResult {
    before: {
        period: string;
        sessions: number;
        events: number;
        completions?: number;
    };
    after: {
        period: string;
        sessions: number;
        events: number;
        completions?: number;
    };
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
    project_id: string;
    total_sessions: number;
    drop_events: FrictionItem[];
    tag?: string;
}
export interface SnippetRow {
    url: string;
    workspace_id: string;
    project_id: string | null;
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
    project_id: string;
    entity_id: string;
    total_events: number;
    events: JourneyEvent[];
}
export interface RecentEvent {
    ts: number;
    event_name: string;
    session_id: string;
    project_id: string;
    tag: string | null;
}
export interface BreakdownItem {
    value: string | null;
    sessions: number;
    events: number;
}
export interface BreakdownResult {
    project_id: string;
    event_name: string;
    property: string;
    period: string;
    total_sessions: number;
    breakdown: BreakdownItem[];
    tag?: string;
}
export declare const LIMITS: {
    event_name_max: number;
    tag_max: number;
    entity_id_max: number;
    properties_max_keys: number;
    property_string_max: number;
};
export declare function normalizeUrl(url: string): string;
export declare function migrate(): Promise<void>;
export declare function insertEvent(workspaceId: string, session_id: string, event_name: string, properties?: Record<string, unknown>, tag?: string | null, entity_id?: string | null, ts?: number, projectId?: string | null): Promise<void>;
/**
 * Met en quarantaine un evenement dont le proprietaire n'a pas pu etre resolu server-side.
 *
 * Ni ecrit dans `events` (il polluerait les donnees d'un client), ni rejete (il serait perdu :
 * l'appel du tracker est fire-and-forget, sans retry). Rejouable une fois le domaine enregistre.
 */
export declare function insertUnresolvedEvent(origin: string | null, payload: unknown): Promise<void>;
export declare function purge(workspaceId: string, projectId: string): Promise<{
    deleted: number;
}>;
export declare function purgeOldEvents(retentionDays: number): Promise<{
    removed: number;
}>;
export declare function listProjects(workspaceId: string): Promise<EventRow[]>;
export declare function summary(workspaceId: string, projectId: string, days: number, tag?: string): Promise<SummaryResult>;
export declare function funnel(workspaceId: string, projectId: string, steps: string[], days: number, tag?: string): Promise<FunnelResult>;
export declare function compare(workspaceId: string, projectId: string, pivot: string, event: string | null, daysBefore: number, daysAfter: number, tag?: string): Promise<CompareResult>;
export declare function friction(workspaceId: string, projectId: string, days: number, tag?: string): Promise<FrictionResult>;
export declare function journey(workspaceId: string, projectId: string, entity_id: string, days: number): Promise<JourneyResult>;
export declare function registerSnippet(workspaceId: string, url: string, projectId: string): Promise<SnippetRow>;
export declare function resolveUrl(workspaceId: string, url: string): Promise<SnippetRow | null>;
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
export declare function resolveByUrl(url: string): Promise<{
    workspace_id: string;
    project_id: string | null;
} | null>;
export declare function listSnippets(workspaceId: string): Promise<SnippetRow[]>;
export declare function breakdown(workspaceId: string, projectId: string, event_name: string, property: string, days: number, tag?: string, limit?: number): Promise<BreakdownResult>;
export declare function recentEvents(workspaceId: string, limit?: number, projectId?: string | null): Promise<RecentEvent[]>;
//# sourceMappingURL=db.d.ts.map