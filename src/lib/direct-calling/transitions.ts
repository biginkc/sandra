import { createHash } from "node:crypto";

import { DIRECT_CALL_TERMINAL_STATUSES, type DirectCallStatus } from "./contract";

/**
 * Pure state machine for a direct call. (row, event) -> (row patch, provider commands).
 * No I/O here: the webhook route persists the patch first, then issues the commands.
 */

export const MAX_CALL_SECS = 7200;
export const SELLER_RING_SECS = 30;
export const STALE_BROWSER_ANSWER_MS = 60_000;

export type LegRole = "browser" | "seller";

export type DirectCallRow = {
  id: string;
  status: DirectCallStatus;
  browser_leg_id: string | null;
  seller_leg_id: string | null;
  destination_e164: string;
  caller_id_e164: string;
  created_at: string;
  connected_at: string | null;
  updated_at?: string;
  failure_reason?: string | null;
  browser_hangup_pending?: boolean;
  seller_hangup_pending?: boolean;
  browser_hangup_acked_at?: string | null;
  seller_hangup_acked_at?: string | null;
  orphan_hangup_leg_ids?: string[];
  seller_dial_state?: SellerDialState | null;
};

/** pending: transition persisted, Dial maybe not sent. sent: provider answered. unknown: outcome unknown, never resend. */
export type SellerDialState = "pending" | "sent" | "unknown";

export type DirectCallEvent = {
  /** Telnyx event_type, e.g. "call.answered". */
  type: string;
  callControlId: string | null;
  /** Leg role decoded from client_state, if present. */
  role: LegRole | null;
  occurredAt: string | null;
  hangupCause: string | null;
};

export type RowPatch = Partial<{
  status: DirectCallStatus;
  browser_leg_id: string;
  seller_leg_id: string;
  hangup_cause: string;
  failure_reason: string | null;
  connected_at: string;
  ended_at: string;
  browser_hangup_pending: boolean;
  seller_hangup_pending: boolean;
  browser_hangup_acked_at: string | null;
  seller_hangup_acked_at: string | null;
  seller_dial_state: SellerDialState;
}>;

export const TEARDOWN_PENDING = "teardown_pending";

export type SellerDialCommand = {
  kind: "dial_seller";
  to: string;
  from: string;
  linkTo: string;
  commandId: string;
  timeoutSecs: number;
  timeLimitSecs: number;
  clientState: Record<string, string>;
  bridgeOnAnswer: true;
  bridgeIntent: false;
};
/** Leg teardown is not a command: it is persisted as per-leg pending flags and retried. */
export type DirectCommand = SellerDialCommand;

/** orphanConfirmed: a provider hangup webhook confirmed this orphan leg is gone (removed atomically by the caller). */
export type TransitionResult = { patch: RowPatch | null; commands: DirectCommand[]; orphanConfirmed?: string };

const NOOP: TransitionResult = { patch: null, commands: [] };

/** Deterministic UUID-shaped id so retried commands are deduplicated by Telnyx. */
export function deterministicCommandId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function hangupCommandId(rowId: string, callControlId: string): string {
  return deterministicCommandId(`${rowId}:${callControlId}:hangup`);
}

const ackedField = (role: LegRole) => (role === "browser" ? "browser_hangup_acked_at" : "seller_hangup_acked_at") as
  | "browser_hangup_acked_at"
  | "seller_hangup_acked_at";

/** Patch fragment that marks a leg's teardown confirmed (flag down, ack cleared). */
const confirmed = (role: LegRole): RowPatch => ({ [pendingFlag(role)]: false, [ackedField(role)]: null });

const pendingFlag = (role: LegRole) => (role === "browser" ? "browser_hangup_pending" : "seller_hangup_pending") as
  | "browser_hangup_pending"
  | "seller_hangup_pending";

/** Any leg (or orphan leg) not yet confirmed ended. This is also the operator-lock predicate. */
export function hasPendingCleanup(
  row: Pick<DirectCallRow, "browser_hangup_pending" | "seller_hangup_pending" | "orphan_hangup_leg_ids">,
): boolean {
  return Boolean(row.browser_hangup_pending || row.seller_hangup_pending || (row.orphan_hangup_leg_ids?.length ?? 0) > 0);
}

/** True once teardown has started: no Dial may ever be issued from here on. */
export function teardownBegun(row: DirectCallRow): boolean {
  return (
    DIRECT_CALL_TERMINAL_STATUSES.has(row.status) ||
    row.status === "ending" ||
    row.failure_reason === TEARDOWN_PENDING ||
    hasPendingCleanup(row)
  );
}

const SETUP: DirectCallStatus[] = ["browser_connecting", "seller_dialing"];
const STALE_SETUP_MS = 150_000; // ring timeouts: 30s + <=60s + 30s
const STALE_ENDING_MS = 60_000;
const STALE_ANY_MS = (MAX_CALL_SECS + 300) * 1000;

/**
 * Terminal status a non-terminal row should be driven to once its legs are torn down,
 * or null if the row is not stale. Time never makes a call terminal by itself: the caller
 * must end the legs first.
 */
export function staleOutcome(row: DirectCallRow, now: Date): DirectCallStatus | null {
  if (DIRECT_CALL_TERMINAL_STATUSES.has(row.status)) return null;
  const age = (iso: string | undefined) => (iso ? now.getTime() - new Date(iso).getTime() : 0);
  const stale =
    row.failure_reason === TEARDOWN_PENDING ||
    age(row.created_at) > STALE_ANY_MS ||
    (SETUP.includes(row.status) && age(row.created_at) > STALE_SETUP_MS) ||
    (row.status === "ending" && age(row.updated_at) > STALE_ENDING_MS);
  if (!stale) return null;
  return SETUP.includes(row.status) ? "failed" : "ended";
}

/** Which leg of this row an event belongs to; null means the event is not ours to act on. */
export function identifyLeg(row: DirectCallRow, event: DirectCallEvent): { role: LegRole; assign: boolean } | null {
  const id = event.callControlId;
  if (!id) return null;
  if (id === row.browser_leg_id) return { role: "browser", assign: false };
  if (id === row.seller_leg_id) return { role: "seller", assign: false };
  if (event.role === "browser" && row.browser_leg_id === null) return { role: "browser", assign: true };
  if (event.role === "seller" && row.seller_leg_id === null) return { role: "seller", assign: true };
  return null;
}

export function nextDirectCallState(row: DirectCallRow, event: DirectCallEvent, now: Date): TransitionResult {
  const leg = identifyLeg(row, event);
  if (event.type === "call.hangup" && event.callControlId && row.orphan_hangup_leg_ids?.includes(event.callControlId)) {
    return { patch: null, commands: [], orphanConfirmed: event.callControlId };
  }
  if (!leg || !event.callControlId) return NOOP;
  const legId = event.callControlId;
  const assignPatch: RowPatch =
    leg.assign ? (leg.role === "browser" ? { browser_leg_id: legId } : { seller_leg_id: legId }) : {};
  const browserLegId = leg.role === "browser" ? legId : row.browser_leg_id;
  const sellerLegId = leg.role === "seller" ? legId : row.seller_leg_id;
  const nowIso = now.toISOString();
  const terminal = DIRECT_CALL_TERMINAL_STATUSES.has(row.status);

  if (event.type === "call.hangup") {
    if (terminal) {
      // The provider confirmed this leg is gone: stop retrying its teardown.
      const flag = pendingFlag(leg.role);
      const patch: RowPatch = { ...assignPatch, ...(row[flag] || row[ackedField(leg.role)] ? confirmed(leg.role) : {}) };
      return { patch: Object.keys(patch).length ? patch : null, commands: [] };
    }
    const other = leg.role === "browser" ? sellerLegId : browserLegId;
    const otherFlag = pendingFlag(leg.role === "browser" ? "seller" : "browser");
    const connected = row.status === "connected" || row.connected_at !== null;
    const ended = connected || row.status === "ending";
    return {
      patch: {
        ...assignPatch,
        status: ended ? "ended" : "failed",
        ended_at: nowIso,
        ...(event.hangupCause ? { hangup_cause: event.hangupCause } : {}),
        ...(ended ? {} : { failure_reason: leg.role === "seller" ? "seller_not_answered" : "browser_hangup_before_connect" }),
        ...confirmed(leg.role),
        ...(other ? { [otherFlag]: true } : {}),
      },
      commands: [],
    };
  }

  if (event.type === "call.answered") {
    // A late answer on a call that is already over (or being torn down): kill that leg.
    if (teardownBegun(row)) {
      return { patch: { ...assignPatch, [pendingFlag(leg.role)]: true }, commands: [] };
    }
    if (leg.role === "browser") {
      if (row.status === "seller_dialing" && row.seller_leg_id === null) {
        // A reprocessed browser answer that finds the Dial transition persisted but no seller leg:
        // the Dial may or may not have gone out, and there is no proven way to dedupe it, so it is
        // never re-sent. Any seller leg seen later is flagged for hangup (terminal-row branch below).
        if (row.seller_dial_state === "pending" || row.seller_dial_state === "unknown") {
          return {
            patch: { ...assignPatch, status: "failed", failure_reason: "dial_outcome_unknown", seller_dial_state: "unknown", ended_at: nowIso, browser_hangup_pending: true },
            commands: [],
          };
        }
      }
      if (row.status !== "browser_connecting") return Object.keys(assignPatch).length ? { patch: assignPatch, commands: [] } : NOOP;
      const elapsedMs = now.getTime() - new Date(row.created_at).getTime();
      if (!(elapsedMs <= STALE_BROWSER_ANSWER_MS)) {
        return {
          patch: { ...assignPatch, status: "failed", failure_reason: "browser_answer_stale", ended_at: nowIso, browser_hangup_pending: true },
          commands: [],
        };
      }
      return { patch: { ...assignPatch, status: "seller_dialing", seller_dial_state: "pending" }, commands: [sellerDial(row, legId, now)] };
    }
    // seller answered
    if (row.status !== "seller_dialing") return Object.keys(assignPatch).length ? { patch: assignPatch, commands: [] } : NOOP;
    return { patch: { ...assignPatch, status: "connected", connected_at: event.occurredAt ?? nowIso }, commands: [] };
  }

  // Any other event for a leg on a finished call: make sure a leg we dialed does not linger.
  if (terminal && (event.type === "call.initiated" || leg.assign)) {
    return { patch: { ...assignPatch, [pendingFlag(leg.role)]: true }, commands: [] };
  }

  // call.bridged and everything else: recorded as an event only.
  const sentPatch: RowPatch = leg.assign && leg.role === "seller" && row.seller_dial_state === "pending" ? { seller_dial_state: "sent" } : {};
  const patch: RowPatch = { ...assignPatch, ...sentPatch };
  return Object.keys(patch).length ? { patch, commands: [] } : NOOP;
}

function sellerDial(row: DirectCallRow, browserLegId: string, now: Date): SellerDialCommand {
  const elapsedMs = now.getTime() - new Date(row.created_at).getTime();
  return {
    kind: "dial_seller",
    to: row.destination_e164,
    from: row.caller_id_e164,
    linkTo: browserLegId,
    commandId: deterministicCommandId(`${row.id}:seller-dial`),
    timeoutSecs: SELLER_RING_SECS,
    timeLimitSecs: Math.max(30, MAX_CALL_SECS - Math.floor(elapsedMs / 1000)),
    clientState: { directCallId: row.id, role: "seller" },
    bridgeOnAnswer: true,
    bridgeIntent: false,
  };
}
