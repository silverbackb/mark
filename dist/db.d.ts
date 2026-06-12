export declare function migrate(): void;
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
export declare const LIMITS: {
    slug_max: number;
    event_name_max: number;
    tag_max: number;
    entity_id_max: number;
    properties_max_keys: number;
    property_string_max: number;
};
export declare function insertEvent(slug: string, session_id: string, event_name: string, properties?: Record<string, unknown>, tag?: string | null, entity_id?: string | null, ts?: number): void;
export declare function purge(slug: string): {
    deleted: number;
};
export declare function listSlugs(): EventRow[];
export declare function summary(slug: string, days: number, tag?: string): SummaryResult;
export declare function funnel(slug: string, steps: string[], days: number, tag?: string): FunnelResult;
export declare function compare(slug: string, pivot: string, event: string | null, daysBefore: number, daysAfter: number, tag?: string): CompareResult;
export declare function friction(slug: string, days: number, tag?: string): FrictionResult;
export declare function journey(slug: string, entity_id: string, days: number): JourneyResult;
export declare function registerSnippet(url: string, slug: string): SnippetRow;
export declare function resolveUrl(url: string): SnippetRow | null;
export declare function listSnippets(): SnippetRow[];
//# sourceMappingURL=db.d.ts.map