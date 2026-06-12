import postgres from "postgres";
declare const sql: postgres.Sql<{}>;
export { sql };
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
    top_events: Array<{
        event: string;
        count: number;
    }>;
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
export declare const LIMITS: {
    slug_max: number;
    event_name_max: number;
    tag_max: number;
    entity_id_max: number;
    properties_max_keys: number;
    property_string_max: number;
};
export declare function migrate(): Promise<void>;
export declare function insertEvent(workspaceId: string, slug: string, session_id: string, event_name: string, properties?: Record<string, unknown>, tag?: string | null, entity_id?: string | null, ts?: number): Promise<void>;
export declare function purge(workspaceId: string, slug: string): Promise<{
    deleted: number;
}>;
export declare function listSlugs(workspaceId: string): Promise<EventRow[]>;
export declare function summary(workspaceId: string, slug: string, days: number, tag?: string): Promise<SummaryResult>;
export declare function funnel(workspaceId: string, slug: string, steps: string[], days: number, tag?: string): Promise<FunnelResult>;
export declare function compare(workspaceId: string, slug: string, pivot: string, event: string | null, daysBefore: number, daysAfter: number, tag?: string): Promise<CompareResult>;
export declare function friction(workspaceId: string, slug: string, days: number, tag?: string): Promise<FrictionResult>;
export declare function journey(workspaceId: string, slug: string, entity_id: string, days: number): Promise<JourneyResult>;
export declare function registerSnippet(workspaceId: string, url: string, slug: string): Promise<SnippetRow>;
export declare function resolveUrl(workspaceId: string, url: string): Promise<SnippetRow | null>;
export declare function listSnippets(workspaceId: string): Promise<SnippetRow[]>;
export declare function recentEvents(workspaceId: string, limit?: number): Promise<RecentEvent[]>;
//# sourceMappingURL=db.d.ts.map