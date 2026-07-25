// Isole la regle du correctif C7 dans une fonction pure, testable sans base de donnees ni
// serveur HTTP : en mode cloud, un x-workspace-id absent, vide ou blanc doit echouer plutot
// que de retomber sur "", le DEFAULT partage des lignes Mark historiques en base.
export type WorkspaceIdDecision =
  | { ok: true; workspaceId: string }
  | { ok: false };

export function resolveQueryWorkspaceId(cloudMode: boolean, rawHeader: string | undefined): WorkspaceIdDecision {
  const workspaceId = (rawHeader ?? "").trim();
  if (cloudMode && workspaceId === "") {
    return { ok: false };
  }
  return { ok: true, workspaceId };
}
