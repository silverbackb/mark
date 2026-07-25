export type WorkspaceIdDecision = {
    ok: true;
    workspaceId: string;
} | {
    ok: false;
};
export declare function resolveQueryWorkspaceId(cloudMode: boolean, rawHeader: string | undefined): WorkspaceIdDecision;
//# sourceMappingURL=workspace-guard.d.ts.map