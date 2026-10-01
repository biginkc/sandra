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
};

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
  failure_reason: string;
  connected_at: string;
  ended_at: string;
}>;

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
export type HangupCommand = { kind: "hangup"; callControlId: string; commandId: string };
export type DirectCommand = SellerDialCommand | HangupCommand;

export type TransitionResult = { patch: RowPatch | null; commands: DirectCommand[] };

const NOOP: TransitionResult = { patch: null, commands: [] };

/** Deterministic UUID-shaped id so retried commands are deduplicated by Telnyx. */
export function deterministicCommandId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function hangupCommand(rowId: string, callControlId: string): HangupCommand {
  return { kind: "hangup", callControlId, commandId: deterministicCommandId(`${rowId}:${callControlId}:hangup`) };
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
  if (!leg || !event.callControlId) return NOOP;
  const legId = event.callControlId;
  const assignPatch: RowPatch =
    leg.assign ? (leg.role === "browser" ? { browser_leg_id: legId } : { seller_leg_id: legId }) : {};
  const browserLegId = leg.role === "browser" ? legId : row.browser_leg_id;
  const sellerLegId = leg.role === "seller" ? legId : row.seller_leg_id;
  const nowIso = now.toISOString();
  const terminal = DIRECT_CALL_TERMINAL_STATUSES.has(row.status);

  if (event.type === "call.hangup") {
    if (terminal) return NOOP;
    const other = leg.role === "browser" ? sellerLegId : browserLegId;
    const connected = row.status === "connected" || row.connected_at !== null;
    const ended = connected || row.status === "ending";
    return {
      patch: {
        ...assignPatch,
        status: ended ? "ended" : "failed",
        ended_at: nowIso,
        ...(event.hangupCause ? { hangup_cause: event.hangupCause } : {}),
        ...(ended ? {} : { failure_reason: leg.role === "seller" ? "seller_not_answered" : "browser_hangup_before_connect" }),
      },
      commands: other ? [hangupCommand(row.id, other)] : [],
    };
  }

  if (event.type === "call.answered") {
    // A late answer on a call that is already over (or being torn down): kill that leg.
    if (terminal || row.status === "ending") {
      return { patch: Object.keys(assignPatch).length ? assignPatch : null, commands: [hangupCommand(row.id, legId)] };
    }
    if (leg.role === "browser") {
      if (row.status !== "browser_connecting") return Object.keys(assignPatch).length ? { patch: assignPatch, commands: [] } : NOOP;
      const elapsedMs = now.getTime() - new Date(row.created_at).getTime();
      if (!(elapsedMs <= STALE_BROWSER_ANSWER_MS)) {
        return {
          patch: { ...assignPatch, status: "failed", failure_reason: "browser_answer_stale", ended_at: nowIso },
          commands: [hangupCommand(row.id, legId)],
        };
      }
      const timeLimitSecs = Math.max(30, MAX_CALL_SECS - Math.floor(elapsedMs / 1000));
      return {
        patch: { ...assignPatch, status: "seller_dialing" },
        commands: [
          {
            kind: "dial_seller",
            to: row.destination_e164,
            from: row.caller_id_e164,
            linkTo: legId,
            commandId: deterministicCommandId(`${row.id}:seller-dial`),
            timeoutSecs: SELLER_RING_SECS,
            timeLimitSecs,
            clientState: { directCallId: row.id, role: "seller" },
            bridgeOnAnswer: true,
            bridgeIntent: false,
          },
        ],
      };
    }
    // seller answered
    if (row.status !== "seller_dialing") return Object.keys(assignPatch).length ? { patch: assignPatch, commands: [] } : NOOP;
    return { patch: { ...assignPatch, status: "connected", connected_at: event.occurredAt ?? nowIso }, commands: [] };
  }

  // call.initiated on a finished call: make sure a leg we dialed does not linger.
  if (terminal && event.type === "call.initiated") {
    return { patch: null, commands: [hangupCommand(row.id, legId)] };
  }

  // call.bridged and everything else: recorded as an event only.
  return Object.keys(assignPatch).length ? { patch: assignPatch, commands: [] } : NOOP;
}
