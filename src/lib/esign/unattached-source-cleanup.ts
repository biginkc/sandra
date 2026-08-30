import type { TemplateActionResult } from "./template-orchestrator";

export type UnattachedSourceCleanupPorts = Readonly<{
  claim(input: { orgId: string; sourceId: string; storagePath: string; actorId: string }): Promise<{
    outcome: "claimed" | "already_in_progress" | "already_deleted";
    sourceId: string;
    cleanupToken: string | null;
    createdBy: string;
  }>;
  deletePrivate(storagePath: string): Promise<"deleted" | "already_absent">;
  complete(input: {
    orgId: string;
    sourceId: string;
    storagePath: string;
    cleanupToken: string;
    outcome: "deleted" | "failed";
    errorCode: string | null;
    actorId: string;
  }): Promise<{
    outcome: "deleted" | "already_deleted" | "failed";
    sourceId: string;
    createdBy: string;
  }>;
}>;

export async function cleanupUnattachedSource(
  input: Readonly<{ orgId: string; sourceId: string; storagePath: string; actorId: string }>,
  ports: UnattachedSourceCleanupPorts,
): Promise<TemplateActionResult<null>> {
  let claim: Awaited<ReturnType<UnattachedSourceCleanupPorts["claim"]>>;
  try { claim = await ports.claim(input); }
  catch { return failure("SOURCE_CLEANUP_CLAIM_FAILED", "The private source cleanup could not be authorized."); }
  if (claim.sourceId !== input.sourceId) return failure("SOURCE_CLEANUP_CLAIM_MISMATCH", "The private source cleanup claim did not match.");
  if (claim.outcome === "already_deleted") return success(null);
  if (claim.outcome === "already_in_progress") return failure("SOURCE_CLEANUP_IN_PROGRESS", "Private source cleanup is already in progress.");
  if (!claim.cleanupToken) return failure("SOURCE_CLEANUP_CLAIM_MISMATCH", "The private source cleanup token was missing.");

  const tokenInput = { ...input, cleanupToken: claim.cleanupToken };
  try {
    const deletion = await ports.deletePrivate(input.storagePath);
    if (deletion !== "deleted" && deletion !== "already_absent") throw new Error("invalid deletion outcome");
  } catch {
    try {
      await ports.complete({ ...tokenInput, outcome: "failed", errorCode: "STORAGE_DELETE_FAILED" });
    } catch {
      return failure("SOURCE_CLEANUP_COMPENSATION_FAILED", "The failed private source cleanup remains in progress.");
    }
    return failure("SOURCE_CLEANUP_FAILED", "The private source could not be deleted. Cleanup remains retryable.");
  }

  const completed = await completeDeletedWithReplay(ports, tokenInput);
  if (!completed) return failure("SOURCE_CLEANUP_RECEIPT_FAILED", "The private source was removed, but cleanup completion requires recovery.");
  return success(null);
}

async function completeDeletedWithReplay(
  ports: UnattachedSourceCleanupPorts,
  input: { orgId: string; sourceId: string; storagePath: string; cleanupToken: string; actorId: string },
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await ports.complete({ ...input, outcome: "deleted", errorCode: null });
      if (result.sourceId === input.sourceId && (result.outcome === "deleted" || result.outcome === "already_deleted")) return true;
      return false;
    } catch {
      // One exact-token replay resolves a committed response loss without issuing another Storage delete.
    }
  }
  return false;
}

function success(data: null): TemplateActionResult<null> { return { ok: true, data }; }
function failure(code: string, message: string): TemplateActionResult<never> { return { ok: false, error: { code, message } }; }
