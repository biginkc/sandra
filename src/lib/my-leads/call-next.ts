import "server-only";

import {
  isQueueRowFor,
  MyLeadsReadError,
  myLeadsViewer,
  readRpc,
  type QueueRow,
} from "./queries";
import { getMyLeadsFlag } from "./flags";
import { schemaReady } from "./schema-ready";
import type { Json } from "@/lib/supabase/types";

export const CALL_NEXT_REASONS = [
  "pinned_call_today",
  "appointment_due",
  "appointment_overdue",
  "inbound_text",
  "inbound_call",
  "needs_offer",
  "offer_follow_up_overdue",
  "hot_going_cold",
  "warm_going_cold",
  "longest_since_touch",
] as const;
export type CallNextReason = (typeof CALL_NEXT_REASONS)[number];
export type CallNextTier = 0 | 1 | 2 | 3 | 4 | 5;

export type CallNextRow = {
  propertyId: string;
  tier: CallNextTier;
  reason: CallNextReason;
  reasonAt: string | null;
  pinned: boolean;
  lastTouchAt: string | null;
  row: QueueRow;
};
export type CallNextExcluded = {
  propertyId: string;
  address: string;
  reason: "no_phone" | "contact_dnc";
};
export type CallNextSnapshot = {
  rows: CallNextRow[];
  excluded: CallNextExcluded[];
  hiddenCount: number;
  snapshotAt: string;
};
export type TriageCursor = { touch: string | null; property: string };
export type TriageSnapshot = {
  rows: { propertyId: string; lastTouchAt: string | null; row: QueueRow }[];
  totalCount: number;
  cursor: TriageCursor | null;
};
export type StripOverrideAction = "call_today" | "not_today" | "clear";
export const STRIP_OVERRIDE_ACTIONS: readonly StripOverrideAction[] = [
  "call_today",
  "not_today",
  "clear",
];

/** Default strip size (decision D2). The RPC accepts 1-25. */
export const CALL_NEXT_LIMIT = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const isIsoOrNull = (v: unknown): v is string | null => v === null || isIso(v);

/** True only when the org flag is on AND the ranking functions exist; anything else is OFF. */
export async function callNextEnabled(orgId: string): Promise<boolean> {
  if (!(await getMyLeadsFlag(orgId, "call_next_strip"))) return false;
  return schemaReady("call_next");
}

function parseRow(value: unknown): CallNextRow | null {
  if (!isRecord(value)) return null;
  const id = value.propertyId;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const tier = value.tier;
  if (typeof tier !== "number" || !Number.isInteger(tier) || tier < 0 || tier > 5) return null;
  if (!(CALL_NEXT_REASONS as readonly unknown[]).includes(value.reason)) return null;
  if (!isIsoOrNull(value.reasonAt ?? null) || !isIsoOrNull(value.lastTouchAt ?? null)) return null;
  if (!isQueueRowFor(value.row, id)) return null;
  return {
    propertyId: id,
    tier: tier as CallNextTier,
    reason: value.reason as CallNextReason,
    reasonAt: (value.reasonAt as string | null | undefined) ?? null,
    pinned: value.pinned === true,
    lastTouchAt: (value.lastTouchAt as string | null | undefined) ?? null,
    row: value.row,
  };
}

function parseExcluded(value: unknown): CallNextExcluded | null {
  if (!isRecord(value)) return null;
  if (typeof value.propertyId !== "string" || !UUID.test(value.propertyId)) return null;
  if (value.reason !== "no_phone" && value.reason !== "contact_dnc") return null;
  return {
    propertyId: value.propertyId,
    address: typeof value.address === "string" ? value.address : "",
    reason: value.reason,
  };
}

/**
 * The Call next strip for one member, or null when the strip is off for the org (flag off,
 * flags table or row missing) or its migration has not landed. A malformed row is dropped,
 * never rendered.
 */
export async function getCallNext(input: { memberId: string }): Promise<CallNextSnapshot | null> {
  const viewer = await myLeadsViewer();
  if (!viewer.isOwner && input.memberId !== viewer.userId)
    throw new MyLeadsReadError("FORBIDDEN", "You can view only your own queue.");
  if (!(await callNextEnabled(viewer.orgId))) return null;
  const data = await readRpc<unknown>(viewer.client, "fn_get_my_leads_call_next", {
    p_org_id: viewer.orgId,
    p_member_id: input.memberId,
    p_limit: CALL_NEXT_LIMIT,
  });
  if (!isRecord(data) || !Array.isArray(data.rows) || !isIso(data.snapshotAt))
    throw new MyLeadsReadError("READ_FAILED", "My Leads returned an unexpected response.");
  const rows = data.rows.map(parseRow).filter((r): r is CallNextRow => r !== null);
  const excluded = (Array.isArray(data.excluded) ? data.excluded : [])
    .map(parseExcluded)
    .filter((r): r is CallNextExcluded => r !== null);
  return {
    rows,
    excluded,
    hiddenCount: typeof data.hiddenCount === "number" ? data.hiddenCount : 0,
    snapshotAt: data.snapshotAt,
  };
}

/** One page of the "untouched, no next step" triage list, or null when the strip is off. */
export async function getTriage(input: {
  memberId: string;
  cursor?: TriageCursor | null;
}): Promise<TriageSnapshot | null> {
  const viewer = await myLeadsViewer();
  if (!viewer.isOwner && input.memberId !== viewer.userId)
    throw new MyLeadsReadError("FORBIDDEN", "You can view only your own queue.");
  if (!(await callNextEnabled(viewer.orgId))) return null;
  const cursor = input.cursor ?? null;
  if (cursor && !UUID.test(cursor.property))
    throw new MyLeadsReadError("INVALID_INPUT", "Refresh the queue and try again.");
  const args: Record<string, Json> = {
    p_org_id: viewer.orgId,
    p_member_id: input.memberId,
    p_days: 14,
    p_limit: 25,
  };
  if (cursor) {
    args.p_after_touch = cursor.touch;
    args.p_after_property = cursor.property;
  }
  const data = await readRpc<unknown>(viewer.client, "fn_get_my_leads_triage", args);
  if (!isRecord(data) || !Array.isArray(data.rows))
    throw new MyLeadsReadError("READ_FAILED", "My Leads returned an unexpected response.");
  const rows: TriageSnapshot["rows"] = [];
  for (const item of data.rows) {
    if (!isRecord(item) || typeof item.propertyId !== "string" || !UUID.test(item.propertyId)) continue;
    if (!isIsoOrNull(item.lastTouchAt ?? null) || !isQueueRowFor(item.row, item.propertyId)) continue;
    rows.push({
      propertyId: item.propertyId,
      lastTouchAt: (item.lastTouchAt as string | null | undefined) ?? null,
      row: item.row,
    });
  }
  const next = isRecord(data.cursor) && typeof data.cursor.property === "string" && UUID.test(data.cursor.property) && isIsoOrNull(data.cursor.touch ?? null)
    ? { touch: (data.cursor.touch as string | null | undefined) ?? null, property: data.cursor.property }
    : null;
  return { rows, totalCount: typeof data.totalCount === "number" ? data.totalCount : rows.length, cursor: next };
}

/** Calls fn_set_my_leads_strip_override. The caller must already have checked the action. */
export async function setCallNextOverride(input: {
  memberId: string;
  propertyId: string;
  action: StripOverrideAction;
}): Promise<{ until: string | null }> {
  if (!(STRIP_OVERRIDE_ACTIONS as readonly string[]).includes(input.action))
    throw new MyLeadsReadError("INVALID_INPUT", "That action is not available.");
  if (!UUID.test(input.propertyId))
    throw new MyLeadsReadError("INVALID_INPUT", "Choose a valid lead.");
  const viewer = await myLeadsViewer();
  if (input.memberId !== viewer.userId)
    throw new MyLeadsReadError("FORBIDDEN", "Open your own queue to change the Call next strip.");
  if (!(await callNextEnabled(viewer.orgId)))
    throw new MyLeadsReadError("FEATURE_DISABLED", "The Call next strip is not enabled yet.");
  const data = await readRpc<unknown>(viewer.client, "fn_set_my_leads_strip_override", {
    p_org_id: viewer.orgId,
    p_member_id: input.memberId,
    p_property_id: input.propertyId,
    p_action: input.action,
  });
  if (!isRecord(data) || data.ok !== true)
    throw new MyLeadsReadError("READ_FAILED", "The change was not confirmed. Please retry.");
  return { until: typeof data.until === "string" ? data.until : null };
}
