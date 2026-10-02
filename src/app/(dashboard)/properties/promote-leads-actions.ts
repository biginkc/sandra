"use server";

import { revalidatePath } from "next/cache";
import { start } from "workflow/api";

import { getCallerMemberships } from "@/lib/auth/memberships";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import { selectAllMatching, type SelectionFilters } from "@/lib/prospects/select-all";
import { promoteLeadsWorkflow } from "@/workflows/promote-leads";

export type PromoteLeadsPreflight = {
  selected: number;
  eligible: number;
  dncLocked: number;
  staleOrNotProspect: number;
};

export type PromotionJobReceipt = {
  jobId: string;
  duplicate: boolean;
  status: string;
  counts: Record<string, number>;
  workflowRunId: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFLIGHT_CHUNK_SIZE = 500;

function uniqueIds(propertyIds: readonly string[]): string[] {
  return [...new Set(propertyIds.filter((id) => UUID_PATTERN.test(id)))];
}

function parseReceipt(data: Json | null): Omit<PromotionJobReceipt, "workflowRunId"> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Promotion RPC returned an invalid receipt.");
  }
  const jobId = data.job_id;
  const duplicate = data.duplicate;
  const status = data.status;
  if (typeof jobId !== "string" || typeof duplicate !== "boolean" || typeof status !== "string") {
    throw new Error("Promotion RPC returned an incomplete receipt.");
  }
  const rawCounts = data.counts;
  const counts: Record<string, number> = {};
  if (rawCounts && typeof rawCounts === "object" && !Array.isArray(rawCounts)) {
    for (const [key, value] of Object.entries(rawCounts)) {
      if (typeof value === "number") counts[key] = value;
    }
  }
  return { jobId, duplicate, status, counts };
}

async function startPromotionWorkflow(
  receipt: Omit<PromotionJobReceipt, "workflowRunId">,
): Promise<Result<PromotionJobReceipt>> {
  if (receipt.status !== "queued") {
    return ok({ ...receipt, workflowRunId: null });
  }
  try {
    const run = await start(promoteLeadsWorkflow, [{ jobId: receipt.jobId }]);
    return ok({ ...receipt, workflowRunId: run.runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportError(error, {
      tags: { surface: "promote_leads_workflow_start" },
      extra: { jobId: receipt.jobId },
    });
    const admin = createAdminClient();
    const checkpoint = await admin.rpc("fail_promote_leads_workflow_start", {
      p_job: receipt.jobId,
      p_error: message,
    });
    if (checkpoint.error) {
      return {
        ok: false,
        error: {
          code: "PROMOTION_START_CHECKPOINT_FAILED",
          message: `Promotion did not start, and its failure could not be checkpointed: ${checkpoint.error.message}`,
        },
      };
    }
    const durableStatus =
      checkpoint.data &&
      typeof checkpoint.data === "object" &&
      !Array.isArray(checkpoint.data) &&
      typeof checkpoint.data.status === "string"
        ? checkpoint.data.status
        : null;
    if (!durableStatus) {
      return {
        ok: false,
        error: {
          code: "PROMOTION_START_CHECKPOINT_FAILED",
          message: "Promotion did not start, and its durable state could not be confirmed.",
        },
      };
    }
    return ok({
      ...receipt,
      status: durableStatus === "failed" ? "failed_to_start" : durableStatus,
      workflowRunId: null,
    });
  }
}

function refreshPromotionSurfaces() {
  revalidatePath("/properties");
  revalidatePath("/leads");
  revalidatePath("/jobs");
}

export async function preflightPromoteLeads(args: {
  orgId: string;
  propertyIds: string[];
}): Promise<Result<PromoteLeadsPreflight>> {
  try {
    const ids = uniqueIds(args.propertyIds);
    const selected = new Set(args.propertyIds).size;
    if (ids.length === 0) {
      return ok({ selected, eligible: 0, dncLocked: 0, staleOrNotProspect: selected });
    }
    const memberships = await getCallerMemberships();
    if (!memberships.some((membership) => membership.org_id === args.orgId)) {
      return {
        ok: false,
        error: { code: "PROMOTION_FORBIDDEN", message: "You no longer have access to this organization." },
      };
    }
    const supabase = await createClient();
    const rows: Array<{ id: string; status: string; is_dnc_locked: boolean }> = [];
    for (let offset = 0; offset < ids.length; offset += PREFLIGHT_CHUNK_SIZE) {
      const { data, error } = await supabase
        .from("properties")
        .select("id, status, is_dnc_locked")
        .eq("org_id", args.orgId)
        .in("id", ids.slice(offset, offset + PREFLIGHT_CHUNK_SIZE))
        .is("deleted_at", null);
      if (error) {
        return { ok: false, error: { code: "PROMOTION_PREFLIGHT_FAILED", message: error.message } };
      }
      rows.push(...(data ?? []));
    }

    const dncLocked = rows.filter((row) => row.is_dnc_locked).length;
    const eligible = rows.filter((row) => row.status === "prospect" && !row.is_dnc_locked).length;
    return ok({
      selected,
      eligible,
      dncLocked,
      staleOrNotProspect: selected - eligible - dncLocked,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "promote_leads_preflight" } });
    return errFromUnknown(error, "PROMOTION_PREFLIGHT_FAILED");
  }
}

export async function createPromoteLeadsJob(args: {
  orgId: string;
  propertyIds: string[];
  idempotencyKey: string;
}): Promise<Result<PromotionJobReceipt>> {
  try {
    const requestedIds = [...new Set(args.propertyIds)];
    const propertyIds = uniqueIds(args.propertyIds);
    if (
      propertyIds.length === 0 ||
      propertyIds.length !== requestedIds.length ||
      !UUID_PATTERN.test(args.idempotencyKey)
    ) {
      return {
        ok: false,
        error: { code: "PROMOTION_INVALID_REQUEST", message: "Select at least one current prospect and try again." },
      };
    }
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("create_promote_leads_job", {
      p_org: args.orgId,
      p_property_ids: propertyIds,
      p_idempotency_key: args.idempotencyKey,
    });
    if (error) {
      return { ok: false, error: { code: "PROMOTION_CREATE_FAILED", message: error.message } };
    }
    const result = await startPromotionWorkflow(parseReceipt(data));
    refreshPromotionSurfaces();
    return result;
  } catch (error) {
    reportError(error, { tags: { surface: "promote_leads_create" } });
    return errFromUnknown(error, "PROMOTION_CREATE_FAILED");
  }
}

export async function retryPromoteLeadsJob(args: {
  parentJobId: string;
  idempotencyKey: string;
}): Promise<Result<PromotionJobReceipt>> {
  try {
    if (!UUID_PATTERN.test(args.idempotencyKey)) {
      return { ok: false, error: { code: "PROMOTION_INVALID_RETRY", message: "Retry request is invalid." } };
    }
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("retry_promote_leads_job", {
      p_parent_job: args.parentJobId,
      p_idempotency_key: args.idempotencyKey,
    });
    if (error) {
      return { ok: false, error: { code: "PROMOTION_RETRY_FAILED", message: error.message } };
    }
    const result = await startPromotionWorkflow(parseReceipt(data));
    refreshPromotionSurfaces();
    return result;
  } catch (error) {
    reportError(error, { tags: { surface: "promote_leads_retry" } });
    return errFromUnknown(error, "PROMOTION_RETRY_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Search page entry points. The legacy actions above are untouched; these always
// apply Search semantics (select-all resolved on the server, capped, org
// membership checked) and have no origin/cap options a client could change.
// ---------------------------------------------------------------------------

async function assertOrgMember(orgId: string): Promise<Result<null>> {
  const memberships = await getCallerMemberships();
  if (!memberships.some((membership) => membership.org_id === orgId)) {
    return {
      ok: false,
      error: { code: "PROMOTION_FORBIDDEN", message: "You no longer have access to this organization." },
    };
  }
  return ok(null);
}

export async function searchPagePreflightPromoteLeads(args: {
  orgId: string;
  propertyIds: string[];
  filters?: SelectionFilters;
}): Promise<Result<PromoteLeadsPreflight>> {
  if (!args.filters) return preflightPromoteLeads({ orgId: args.orgId, propertyIds: args.propertyIds });
  try {
    const member = await assertOrgMember(args.orgId);
    if (!member.ok) return member;
    const resolved = await selectAllMatching(args.filters, "search");
    if (!resolved.ok) return resolved;
    return ok({
      selected: resolved.data.matchedCount,
      eligible: resolved.data.eligibleIds.length,
      dncLocked: resolved.data.dncLockedCount,
      staleOrNotProspect: resolved.data.skippedLeads,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "promote_leads_preflight" } });
    return errFromUnknown(error, "PROMOTION_PREFLIGHT_FAILED");
  }
}

export async function searchPageCreatePromoteLeadsJob(args: {
  orgId: string;
  propertyIds: string[];
  idempotencyKey: string;
  filters?: SelectionFilters;
}): Promise<Result<PromotionJobReceipt>> {
  try {
    // Same org-membership check as preflight; do not rely only on the RPC.
    const member = await assertOrgMember(args.orgId);
    if (!member.ok) return member;
    let propertyIds = args.propertyIds;
    if (args.filters) {
      const resolved = await selectAllMatching(args.filters, "search");
      if (!resolved.ok) return resolved;
      propertyIds = resolved.data.eligibleIds;
    }
    return await createPromoteLeadsJob({
      orgId: args.orgId,
      propertyIds,
      idempotencyKey: args.idempotencyKey,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "promote_leads_create" } });
    return errFromUnknown(error, "PROMOTION_CREATE_FAILED");
  }
}
