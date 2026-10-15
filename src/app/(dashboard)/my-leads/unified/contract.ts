/**
 * Shared contract for the unified work queue (design v8, Phase B1).
 * Mirrors the jsonb returned by fn_my_leads_work_page / fn_my_leads_work_facts
 * (supabase/migrations/20261015010000_my_leads_work_queue_classifier.sql). Do not change a field
 * here without changing the SQL contract; keep this file free of server-only imports.
 */
import type { HomeownerHouses } from "@/lib/leads/homeowner-houses";
import type { QueueRow } from "@/lib/my-leads/queries";

export const WORK_TABS = ["needs_attention", "waiting", "all"] as const;
export type WorkTab = (typeof WORK_TABS)[number];
export const WORK_TAB_LABELS: Record<WorkTab, string> = {
  needs_attention: "Needs attention",
  waiting: "Waiting on them",
  all: "All leads",
};

export type WorkPlace = "your_move" | "their_move" | "neither";
export type WorkReason =
  | "under_contract" | "call_today" | "new_lead" | "due" | "new_reply" | "broken" | "offer"
  | "gone_quiet" | "nothing_planned" | "in_drip" | "texted_last" | "offer_out" | "callback_booked";
export type WorkStage = "not_contacted" | "contacted" | "needs_offer" | "offer_sent" | "under_contract";

/** Chip order is binding (design v8 section 6). "all" is the All reasons / All waiting chip. */
export const NEEDS_ATTENTION_CHIPS = [
  "new_lead", "call_today", "due", "new_reply", "broken", "offer", "gone_quiet", "nothing_planned", "all",
] as const;
export const WAITING_CHIPS = ["in_drip", "texted_last", "offer_out", "callback_booked", "all"] as const;
export type WorkChip = (typeof NEEDS_ATTENTION_CHIPS)[number] | (typeof WAITING_CHIPS)[number];

export const WORK_PAGE_SIZE = 25;

export type BrokenKind =
  | "drip_paused" | "drip_stuck" | "followup_text_not_delivered" | "followup_text_blocked"
  | "followup_text_status_unknown" | "followup_text_not_sent" | "text_not_delivered" | "text_blocked"
  | "text_status_unknown" | "text_not_sent" | "scheduled_text_overdue" | "ai_reply_failed" | "norma_needs_review";
export type BrokenAction = "fix_drip" | "send_text" | "resend" | "review" | "check_status" | "open_campaign";
/** refId is what Dismiss sends as source_id (null for items that cannot be dismissed: campaign/Norma). */
export type BrokenItem = { kind: BrokenKind; action: BrokenAction; at: string | null; refId: string | null };

export type WorkDrip = {
  enrollmentId: string; status: string; pauseReason: string | null; name: string | null;
  step: number | null; stepsTotal: number | null; nextRunAt: string | null; completedAt: string | null;
  lastSentAt: string | null; healthy: boolean;
};

/**
 * headline varies by rowNo (the SQL builds it per decision row):
 *  2 {pinnedAt}  3 {assignedAt, firstCallOverdue}  4 {at, soon}  9 {at, overdueDays}  5 {at, kind:'text'|'call'}
 *  6 {kind: BrokenKind, action: BrokenAction, at}  6a {variant:'text_waiting', at}  7 {kind:'ready', since}
 *  8 {kind:'follow_up_due'|'follow_up_missing', at}  10 {nextRunAt, scheduledAt, callInProgress, resumeBy}
 *  11 {kind:'offer_out'|'callback_booked', at}  12 {at}  13 {at, by:'human'|'ai'|'campaign', until}
 *  Rows 4, 9 and 11(callback_booked) also carry {taskKind:'callback'|'appointment', snoozed:boolean} (migration 20261015020200).
 *  14 {kind:'texted_silent'|'drip_finished', at, since}  15 {variant: 'check_texts'|null}  1 {signedAt}
 */
export type WorkHeadline = Record<string, unknown>;

export type LastTouchKind =
  | "your_text" | "sandra_reply" | "drip_text" | "campaign_text" | "call_reached" | "call_no_answer"
  | "voicemail" | "note" | "other";

export type WorkLabel =
  | "norma_calling" | "norma_task" | "do_not_contact" | "text_waiting" | "check_texts" | "broken"
  | "ai_draft_waiting" | "no_phone";

export type WorkFacts = {
  propertyId: string;
  stage: WorkStage;
  place: WorkPlace;
  reason: WorkReason;
  rowNo: string;
  reasonAt: string | null;
  headline: WorkHeadline;
  drip: WorkDrip | null;
  nextStep: { callbackAt: string | null; offerFollowUpAt: string | null } | null;
  lastTouchAt: string | null;
  attemptsCount: number;
  assignedAt: string | null;
  latestInbound: { at: string; kind: "text" | "call"; messageId: string | null; handled: boolean; contactOnly: boolean } | null;
  hasPhone: boolean;
  contactDnc: boolean;
  broken: BrokenItem[];
  aiDraftId: string | null;
  labels: WorkLabel[];
  /** Added by migration 20261015020200 (design owner answers 1-3). zip comes from properties; null when absent. */
  zip: string | null;
  /** When the recorded contract was signed (Under contract rows); null when unknown. */
  contractSignedAt: string | null;
  /** What the last touch was and when (null = none yet). 'other' = a touch kind the owner's list does not name. */
  lastTouch: { kind: LastTouchKind; at: string } | null;
  /** The existing queue row; feeds the existing dialogs/workflows unchanged. */
  row: QueueRow;
  /** Every house this homeowner owns in the org (the "Owns N houses" badge); absent when unknown. */
  homeownerHouses?: HomeownerHouses;
};

export type WorkPage = {
  rows: WorkFacts[];
  ids: string[];
  total: number;
  page: number;
  pageSize: number;
  tabCounts: Record<WorkTab, number>;
  chipCounts: Partial<Record<WorkReason, number>>;
  stageCounts: Partial<Record<WorkStage, number>>;
  revision: string;
  nextChangeAt: string | null;
  snapshotAt: string;
};

export type WorkFactsResult = { rows: WorkFacts[]; missing: string[]; snapshotAt: string };

export type WorkQuery = { tab: WorkTab; chip: WorkChip; stage: WorkStage | null; search: string; page: number };

/** The slot icon, priority order (design v8 section 4). */
export type SlotIcon = "new_reply" | "broken" | "new_lead" | "in_drip" | "no_drip";

/** The server-action results the UI consumes (src/app/(dashboard)/my-leads/unified-actions.ts). */
export type UnifiedActionFailure = { ok: false; code?: string; message: string };
export type LoadWorkPageResult = ({ ok: true } & { page: WorkPage }) | UnifiedActionFailure;
export type LoadWorkFactsResult = ({ ok: true } & { facts: WorkFactsResult }) | UnifiedActionFailure;

/**
 * Server actions in src/app/(dashboard)/my-leads/unified-actions.ts (all "use server"; the member must be
 * the viewer or the viewer must be the owner, enforced by the RPCs; pin/dismiss are member-only):
 *   loadWorkPage({ memberId, query })                 -> LoadWorkPageResult
 *   loadWorkFacts({ memberId, ids })                  -> LoadWorkFactsResult   (<= 50 ids)
 *   pinLead({ memberId, propertyId, action })         -> { ok: true; pinnedAt: string | null } | UnifiedActionFailure   ('pin' | 'clear')
 *   dismissBroken({ memberId, propertyId, sourceId }) -> { ok: true } | UnifiedActionFailure
 *   loadUnifiedKpis({ memberId })                     -> { ok: true; kpis: AcquisitionKpis } | UnifiedActionFailure
 */
import type { AcquisitionKpis } from "@/lib/my-leads/queries";

/** Everything the server renders into the first paint of the unified page. */
export type UnifiedInitial = {
  query: WorkQuery;
  /** null when the first read failed; the client shows the error banner and retries. */
  page: WorkPage | null;
  error: string | null;
  kpis: AcquisitionKpis | null;
  /** Facts for a deep-linked lead (?lead=), whatever tab it belongs to; pinned at the top of that tab. */
  pinned: WorkFacts | null;
};
