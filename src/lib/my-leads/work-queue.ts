import "server-only";

import {
  NEEDS_ATTENTION_CHIPS,
  WAITING_CHIPS,
  WORK_PAGE_SIZE,
  WORK_TABS,
  type BrokenItem,
  type LastTouchKind,
  type WorkDrip,
  type WorkFacts,
  type WorkFactsResult,
  type WorkLabel,
  type WorkPage,
  type WorkPlace,
  type WorkQuery,
  type WorkReason,
  type WorkStage,
  type WorkTab,
} from "@/app/(dashboard)/my-leads/unified/contract";
import { isQueueRowFor, MyLeadsReadError, myLeadsViewer, readBadgeV2, readRpc } from "./queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FACT_IDS = 50;
const MAX_PAGE_SIZE = 50;

const STAGES: readonly string[] = ["not_contacted", "contacted", "needs_offer", "offer_sent", "under_contract"];
const PLACES: readonly string[] = ["your_move", "their_move", "neither"];
const REASONS: readonly string[] = [
  "under_contract", "call_today", "new_lead", "due", "new_reply", "broken", "offer",
  "gone_quiet", "nothing_planned", "in_drip", "texted_last", "offer_out", "callback_booked",
];
const LABELS: readonly string[] = [
  "norma_calling", "norma_task", "do_not_contact", "text_waiting", "check_texts", "broken", "ai_draft_waiting", "no_phone",
];
const BROKEN_KINDS: readonly string[] = [
  "drip_paused", "drip_stuck", "followup_text_not_delivered", "followup_text_blocked",
  "followup_text_status_unknown", "followup_text_not_sent", "text_not_delivered", "text_blocked",
  "text_status_unknown", "text_not_sent", "scheduled_text_overdue", "ai_reply_failed", "norma_needs_review",
];
const BROKEN_ACTIONS: readonly string[] = ["fix_drip", "send_text", "resend", "review", "check_status", "open_campaign"];
const LAST_TOUCH_KINDS: readonly string[] = [
  "your_text", "sandra_reply", "drip_text", "campaign_text", "call_reached", "call_no_answer", "voicemail", "note", "other",
];
const CHIPS: readonly string[] = [...NEEDS_ATTENTION_CHIPS, ...WAITING_CHIPS];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isIsoOrNull = (v: unknown): v is string | null => v === null || isIso(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isNumOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const malformed = () => new MyLeadsReadError("READ_FAILED", "My Leads returned an unexpected response.");

function parseDrip(value: unknown): WorkDrip | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const v = value;
  if (typeof v.enrollmentId !== "string" || typeof v.status !== "string") return undefined;
  const nullableText = (x: unknown) => x === null || x === undefined || typeof x === "string";
  if (!nullableText(v.pauseReason) || !nullableText(v.name)) return undefined;
  if (![v.step ?? null, v.stepsTotal ?? null].every(isNumOrNull)) return undefined;
  if (![v.nextRunAt ?? null, v.completedAt ?? null, v.lastSentAt ?? null].every(isIsoOrNull)) return undefined;
  return {
    enrollmentId: v.enrollmentId,
    status: v.status,
    pauseReason: (v.pauseReason as string | null | undefined) ?? null,
    name: (v.name as string | null | undefined) ?? null,
    step: (v.step as number | null | undefined) ?? null,
    stepsTotal: (v.stepsTotal as number | null | undefined) ?? null,
    nextRunAt: (v.nextRunAt as string | null | undefined) ?? null,
    completedAt: (v.completedAt as string | null | undefined) ?? null,
    lastSentAt: (v.lastSentAt as string | null | undefined) ?? null,
    healthy: v.healthy === true,
  };
}

function parseBroken(value: unknown): BrokenItem[] | undefined {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const items: BrokenItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || !BROKEN_KINDS.includes(item.kind as string) || !BROKEN_ACTIONS.includes(item.action as string)) return undefined;
    if (!isIsoOrNull(item.at ?? null)) return undefined;
    const refId = item.refId ?? null;
    if (refId !== null && (typeof refId !== "string" || !UUID.test(refId))) return undefined;
    items.push({ kind: item.kind as BrokenItem["kind"], action: item.action as BrokenItem["action"], at: (item.at as string | null | undefined) ?? null, refId });
  }
  return items;
}

function parseInbound(value: unknown): WorkFacts["latestInbound"] | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isIso(value.at) || (value.kind !== "text" && value.kind !== "call")) return undefined;
  const messageId = value.messageId ?? null;
  if (messageId !== null && typeof messageId !== "string") return undefined;
  return { at: value.at, kind: value.kind, messageId, handled: value.handled === true, contactOnly: value.contactOnly === true };
}

function parseNextStep(value: unknown): WorkFacts["nextStep"] | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isIsoOrNull(value.callbackAt ?? null) || !isIsoOrNull(value.offerFollowUpAt ?? null)) return undefined;
  return {
    callbackAt: (value.callbackAt as string | null | undefined) ?? null,
    offerFollowUpAt: (value.offerFollowUpAt as string | null | undefined) ?? null,
  };
}

/** Absent (a deploy before the migration) reads as null; present-but-malformed is rejected. */
function parseLastTouch(value: unknown): WorkFacts["lastTouch"] | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !LAST_TOUCH_KINDS.includes(value.kind as string) || !isIso(value.at)) return undefined;
  return { kind: value.kind as LastTouchKind, at: value.at };
}

/** One classifier row. Returns null when any field the UI relies on is missing or has the wrong type. */
export function parseWorkFacts(value: unknown): WorkFacts | null {
  if (!isRecord(value)) return null;
  const id = value.propertyId;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (!STAGES.includes(value.stage as string) || !PLACES.includes(value.place as string) || !REASONS.includes(value.reason as string)) return null;
  if (typeof value.rowNo !== "string" || !isRecord(value.headline)) return null;
  if (![value.reasonAt ?? null, value.lastTouchAt ?? null, value.assignedAt ?? null].every(isIsoOrNull)) return null;
  if (!isCount(value.attemptsCount) || typeof value.hasPhone !== "boolean" || typeof value.contactDnc !== "boolean") return null;
  if (!Array.isArray(value.labels) || !value.labels.every((l) => LABELS.includes(l as string))) return null;
  if (value.aiDraftId !== null && value.aiDraftId !== undefined && typeof value.aiDraftId !== "string") return null;
  if (!isQueueRowFor(value.row, id)) return null;
  const drip = parseDrip(value.drip);
  const broken = parseBroken(value.broken);
  const latestInbound = parseInbound(value.latestInbound);
  const nextStep = parseNextStep(value.nextStep);
  const lastTouch = parseLastTouch(value.lastTouch);
  const zip = value.zip ?? null;
  if (zip !== null && typeof zip !== "string") return null;
  if (!isIsoOrNull(value.contractSignedAt ?? null)) return null;
  if (drip === undefined || broken === undefined || latestInbound === undefined || nextStep === undefined || lastTouch === undefined) return null;
  return {
    propertyId: id,
    stage: value.stage as WorkStage,
    place: value.place as WorkPlace,
    reason: value.reason as WorkReason,
    rowNo: value.rowNo,
    reasonAt: (value.reasonAt as string | null | undefined) ?? null,
    headline: value.headline,
    drip,
    nextStep,
    lastTouchAt: (value.lastTouchAt as string | null | undefined) ?? null,
    attemptsCount: value.attemptsCount,
    assignedAt: (value.assignedAt as string | null | undefined) ?? null,
    latestInbound,
    hasPhone: value.hasPhone,
    contactDnc: value.contactDnc,
    broken,
    aiDraftId: (value.aiDraftId as string | null | undefined) ?? null,
    labels: value.labels as WorkLabel[],
    zip: zip === null || zip.trim() === "" ? null : zip.trim(),
    contractSignedAt: (value.contractSignedAt as string | null | undefined) ?? null,
    lastTouch,
    row: value.row,
  };
}

function parseCounts(value: unknown, keys: readonly string[]): Record<string, number> | null {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) {
    if (!keys.includes(key) || !isCount(n)) return null;
    out[key] = n;
  }
  return out;
}

export function parseWorkPage(data: unknown): WorkPage {
  if (!isRecord(data) || !Array.isArray(data.rows) || !Array.isArray(data.ids)) throw malformed();
  const rows: WorkFacts[] = [];
  for (const item of data.rows) {
    const facts = parseWorkFacts(item);
    if (!facts) throw malformed();
    rows.push(facts);
  }
  const ids = data.ids;
  if (ids.length !== rows.length || ids.some((id, i) => id !== rows[i].propertyId)) throw malformed();
  if (!isCount(data.total) || !isCount(data.page) || data.page < 1 || !isCount(data.pageSize) || data.pageSize < 1) throw malformed();
  if (typeof data.revision !== "string" || !isIso(data.snapshotAt) || !isIsoOrNull(data.nextChangeAt ?? null)) throw malformed();
  const tabs = isRecord(data.tabCounts) ? data.tabCounts : null;
  if (!tabs || !WORK_TABS.every((tab) => isCount(tabs[tab]))) throw malformed();
  const chipCounts = parseCounts(data.chipCounts, REASONS);
  const stageCounts = parseCounts(data.stageCounts, STAGES);
  if (!chipCounts || !stageCounts) throw malformed();
  return {
    rows,
    ids: ids as string[],
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
    tabCounts: Object.fromEntries(WORK_TABS.map((tab) => [tab, tabs[tab] as number])) as Record<WorkTab, number>,
    chipCounts: chipCounts as WorkPage["chipCounts"],
    stageCounts: stageCounts as WorkPage["stageCounts"],
    revision: data.revision,
    nextChangeAt: (data.nextChangeAt as string | null | undefined) ?? null,
    snapshotAt: data.snapshotAt,
  };
}

export function parseWorkFactsResult(data: unknown): WorkFactsResult {
  if (!isRecord(data) || !Array.isArray(data.rows) || !isIso(data.snapshotAt)) throw malformed();
  const missing = data.missing ?? [];
  if (!Array.isArray(missing) || !missing.every((id) => typeof id === "string" && UUID.test(id))) throw malformed();
  const rows: WorkFacts[] = [];
  for (const item of data.rows) {
    const facts = parseWorkFacts(item);
    if (!facts) throw malformed();
    rows.push(facts);
  }
  return { rows, missing: missing as string[], snapshotAt: data.snapshotAt };
}

function assertReadable(viewer: { isOwner: boolean; userId: string }, memberId: string) {
  if (!viewer.isOwner && memberId !== viewer.userId)
    throw new MyLeadsReadError("FORBIDDEN", "You can view only your own queue.");
}

/** One page of the unified queue for one member. The caller has already checked the unified flag. */
export async function getWorkPage(input: {
  memberId: string;
  query: WorkQuery;
  size?: number;
}): Promise<WorkPage> {
  const { query } = input;
  const size = input.size ?? WORK_PAGE_SIZE;
  if (
    !UUID.test(input.memberId) ||
    !(WORK_TABS as readonly string[]).includes(query.tab) ||
    !CHIPS.includes(query.chip) ||
    (query.stage !== null && !STAGES.includes(query.stage)) ||
    !Number.isInteger(query.page) || query.page < 1 ||
    !Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE ||
    query.search.length > 200
  )
    throw new MyLeadsReadError("INVALID_INPUT", "Refresh the queue or check the selected filters.");
  const viewer = await myLeadsViewer();
  assertReadable(viewer, input.memberId);
  const data = await readRpc<unknown>(viewer.client, "fn_my_leads_work_page", {
    p_org_id: viewer.orgId,
    p_member_id: input.memberId,
    p_tab: query.tab,
    p_chip: query.chip,
    p_stage: query.stage,
    p_search: query.search.trim(),
    p_page: query.page,
    p_size: size,
    p_at: null,
  });
  return parseWorkPage(data);
}

/** Current facts for up to 50 leads (retained rows, or the one row an action touched). */
export async function getWorkFacts(memberId: string, ids: string[]): Promise<WorkFactsResult> {
  if (!UUID.test(memberId) || ids.length > MAX_FACT_IDS || !ids.every((id) => UUID.test(id)))
    throw new MyLeadsReadError("INVALID_INPUT", "Refresh the queue and try again.");
  const viewer = await myLeadsViewer();
  assertReadable(viewer, memberId);
  const data = await readRpc<unknown>(viewer.client, "fn_my_leads_work_facts", {
    p_org_id: viewer.orgId,
    p_member_id: memberId,
    p_ids: ids,
    p_at: null,
  });
  return parseWorkFactsResult(data);
}

/** Call today (pin, no expiry) or its Undo (clear). The caller has already checked the unified flag. */
export async function setPin(
  memberId: string,
  propertyId: string,
  action: "pin" | "clear",
): Promise<{ pinnedAt: string | null }> {
  if (action !== "pin" && action !== "clear") throw new MyLeadsReadError("INVALID_INPUT", "That action is not available.");
  if (!UUID.test(propertyId)) throw new MyLeadsReadError("INVALID_INPUT", "Choose a valid lead.");
  const viewer = await myLeadsViewer();
  if (memberId !== viewer.userId) throw new MyLeadsReadError("FORBIDDEN", "Open your own queue to change Call today.");
  const data = await readRpc<unknown>(viewer.client, "fn_set_my_leads_pin", {
    p_org_id: viewer.orgId,
    p_member_id: memberId,
    p_property_id: propertyId,
    p_action: action,
  });
  if (!isRecord(data) || data.ok !== true) throw new MyLeadsReadError("READ_FAILED", "The change was not confirmed. Please retry.");
  const pinnedAt = data.pinnedAt ?? null;
  if (!isIsoOrNull(pinnedAt) || (action === "pin" && pinnedAt === null)) throw new MyLeadsReadError("READ_FAILED", "The change was not confirmed. Please retry.");
  return { pinnedAt };
}

/** Dismiss on a Broken row; sourceId is the refId the classifier reported. Repeating it is a no-op. */
export async function dismissBroken(memberId: string, propertyId: string, sourceId: string): Promise<void> {
  if (!UUID.test(propertyId) || !UUID.test(sourceId)) throw new MyLeadsReadError("INVALID_INPUT", "Choose a valid lead.");
  const viewer = await myLeadsViewer();
  if (memberId !== viewer.userId) throw new MyLeadsReadError("FORBIDDEN", "Open your own queue to dismiss this.");
  const data = await readRpc<unknown>(viewer.client, "fn_dismiss_my_leads_broken", {
    p_org_id: viewer.orgId,
    p_member_id: memberId,
    p_property_id: propertyId,
    p_source_id: sourceId,
  });
  if (!isRecord(data) || data.ok !== true) throw new MyLeadsReadError("READ_FAILED", "The change was not confirmed. Please retry.");
}

/** Sidebar badge for the signed-in user: distinct leads in Due / New reply / Broken. */
export async function getBadgeV2(): Promise<number> {
  const viewer = await myLeadsViewer();
  return readBadgeV2(viewer.client);
}

/** The first ten leads of Needs attention (page 1, no filters); what the comps job enriches. */
export async function getNeedsAttentionTopTen(memberId: string): Promise<string[]> {
  const page = await getWorkPage({
    memberId,
    query: { tab: "needs_attention", chip: "all", stage: null, search: "", page: 1 },
    size: 10,
  });
  return page.ids;
}
