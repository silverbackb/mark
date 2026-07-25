export function resolveQueryWorkspaceId(cloudMode, rawHeader) {
    const workspaceId = (rawHeader ?? "").trim();
    if (cloudMode && workspaceId === "") {
        return { ok: false };
    }
    return { ok: true, workspaceId };
}
//# sourceMappingURL=workspace-guard.js.map