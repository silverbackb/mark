import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveQueryWorkspaceId } from "./workspace-guard.js";

test("mode cloud : x-workspace-id absent est refuse", () => {
  const decision = resolveQueryWorkspaceId(true, undefined);
  assert.equal(decision.ok, false);
});

test("mode cloud : x-workspace-id vide est refuse", () => {
  const decision = resolveQueryWorkspaceId(true, "");
  assert.equal(decision.ok, false);
});

test("mode cloud : x-workspace-id blanc est refuse", () => {
  const decision = resolveQueryWorkspaceId(true, "   ");
  assert.equal(decision.ok, false);
});

test("mode cloud : x-workspace-id valide est accepte", () => {
  const decision = resolveQueryWorkspaceId(true, "ws_123");
  assert.deepEqual(decision, { ok: true, workspaceId: "ws_123" });
});

test("mode self-hosted : x-workspace-id absent est accepte (comportement historique)", () => {
  const decision = resolveQueryWorkspaceId(false, undefined);
  assert.deepEqual(decision, { ok: true, workspaceId: "" });
});
