"use server";

import { reportError } from "@/lib/errors/report";
import {
  getAcquisitionKpis,
  MyLeadsReadError,
  myLeadsViewer,
  type MyLeadsViewer,
  type AcquisitionKpis,
} from "@/lib/my-leads/queries";
import { unifiedQueueEnabled } from "@/lib/my-leads/unified-queue";
import { dismissBroken as dismissBrokenRpc, getWorkFacts, getWorkPage, setPin } from "@/lib/my-leads/work-queue";

import type {
  LoadWorkFactsResult,
  LoadWorkPageResult,
  UnifiedActionFailure,
  WorkQuery,
} from "./unified/contract";

const FEATURE_OFF: UnifiedActionFailure = {
  ok: false,
  code: "FEATURE_DISABLED",
  message: "The unified My Leads queue is not enabled yet.",
};

function reportUnifiedFailure(operation: string, error: unknown) {
  reportError(error instanceof Error ? error : new Error(`${operation} failed`), {
    errorClass: "database",
    tags: { surface: "database", operation },
  });
}

function failure(operation: string, error: unknown, fallback: string): UnifiedActionFailure {
  reportUnifiedFailure(operation, error);
  if (error instanceof MyLeadsReadError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: "READ_FAILED", message: fallback };
}

/** Server-side flag re-check: a client that kept an old bundle can never reach the unified RPCs while the org is off. */
async function resolveViewer(): Promise<{ viewer: MyLeadsViewer; off: boolean }> {
  const viewer = await myLeadsViewer();
  return { viewer, off: !(await unifiedQueueEnabled(viewer.orgId)) };
}

export async function loadWorkPage(input: { memberId: string; query: WorkQuery }): Promise<LoadWorkPageResult> {
  try {
    const { viewer, off } = await resolveViewer();
    if (off) return FEATURE_OFF;
    return { ok: true, page: await getWorkPage({ memberId: input.memberId, query: input.query, viewer }) };
  } catch (error) {
    return failure("my_leads_work_page", error, "My Leads could not load. Please retry.");
  }
}

export async function loadWorkFacts(input: { memberId: string; ids: string[] }): Promise<LoadWorkFactsResult> {
  try {
    const { viewer, off } = await resolveViewer();
    if (off) return FEATURE_OFF;
    return { ok: true, facts: await getWorkFacts(input.memberId, input.ids, viewer) };
  } catch (error) {
    return failure("my_leads_work_facts", error, "My Leads could not refresh. Please retry.");
  }
}

export async function pinLead(input: {
  memberId: string;
  propertyId: string;
  action: "pin" | "clear";
}): Promise<{ ok: true; pinnedAt: string | null } | UnifiedActionFailure> {
  if (input.action !== "pin" && input.action !== "clear")
    return { ok: false, code: "INVALID_INPUT", message: "That action is not available." };
  try {
    const { viewer, off } = await resolveViewer();
    if (off) return FEATURE_OFF;
    const { pinnedAt } = await setPin(input.memberId, input.propertyId, input.action, viewer);
    return { ok: true, pinnedAt };
  } catch (error) {
    return failure("my_leads_pin", error, "The change could not be saved. Please retry.");
  }
}

export async function dismissBroken(input: {
  memberId: string;
  propertyId: string;
  sourceId: string;
}): Promise<{ ok: true } | UnifiedActionFailure> {
  try {
    const { viewer, off } = await resolveViewer();
    if (off) return FEATURE_OFF;
    await dismissBrokenRpc(input.memberId, input.propertyId, input.sourceId, viewer);
    return { ok: true };
  } catch (error) {
    return failure("my_leads_dismiss_broken", error, "The change could not be saved. Please retry.");
  }
}

export async function loadUnifiedKpis(input: {
  memberId: string;
}): Promise<{ ok: true; kpis: AcquisitionKpis } | UnifiedActionFailure> {
  try {
    const { viewer, off } = await resolveViewer();
    if (off) return FEATURE_OFF;
    return { ok: true, kpis: await getAcquisitionKpis({ memberId: input.memberId, period: "today", viewer }) };
  } catch (error) {
    return failure("my_leads_unified_kpis", error, "The numbers could not load. Please retry.");
  }
}
