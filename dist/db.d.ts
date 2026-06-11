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
}
export interface FunnelResult {
    slug: string;
    steps: string[];
    counts: number[];
    rates: number[];
    drop_at: string | null;
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
}
export declare function insertEvent(slug: string, session_id: string, event_name: string, properties?: Record<string, unknown>): void;
export declare function purge(slug: string): {
    deleted: number;
};
export declare function listSlugs(): EventRow[];
export declare function summary(slug: string, days: number): SummaryResult;
export declare function funnel(slug: string, steps: string[], days: number): FunnelResult;
export declare function compare(slug: string, pivot: string, event: string | null, daysBefore: number, daysAfter: number): CompareResult;
export declare function friction(slug: string, days: number): FrictionResult;
//# sourceMappingURL=db.d.ts.map