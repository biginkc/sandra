import { createHash } from "node:crypto";

import { runLegCleanup } from "./cleanup";
import { DIRECT_CALL_TERMINAL_STATUSES, type DirectCallStatus } from "./contract";
import type { DirectCallFullRow, DirectCallStore } from "./store";
import {
  hangupCommandId,
  nextDirectCallState,
  type DirectCallEvent,
  type DirectCommand,
  type LegRole,
  type SellerDialCommand,
} from "./transitions";
import { TelnyxApiError, decodeClientState, type DialParams } from "./telnyx";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CAS_ATTEMPTS = 3;
const LIVE: DirectCallStatus[] = ["browser_connecting", "seller_dialing", "connected", "ending"];

export type WebhookDeps = {
  store: DirectCallStore;
  dial: (params: DialParams) => Promise<{ callControlId: string }>;
  hangup: (callControlId: string, commandId: string) => Promise<void>;
  now: () => Date;
  report: (error: unknown, tag: string) => void;
};

export type WebhookOutcome = { status: 200; result: "duplicate" | "stored_only" | "processed" };

type Envelope = {
  data?: {
    id?: unknown;
    event_type?: unknown;
    occurred_at?: unknown;
    payload?: { call_control_id?: unknown; client_state?: unknown; hangup_cause?: unknown } & Record<string, unknown>;
  };
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseDirectEvent(rawBody: string): { eventId: string; event: DirectCallEvent; claimedCallId: string | null; occurredAt: string | null; raw: unknown } | null {
  let parsed: Envelope;
  try {
    parsed = JSON.parse(rawBody) as Envelope;
  } catch {
    return null;
  }
  const data = parsed?.data;
  const type = str(data?.event_type);
  if (!data || !type) return null;
  const payload = data.payload ?? {};
  const state = decodeClientState(payload.client_state);
  const role: LegRole | null = state?.role === "browser" || state?.role === "seller" ? state.role : null;
  const claimed = str(state?.directCallId);
  const occurredRaw = str(data.occurred_at);
  const occurredAt = occurredRaw && !Number.isNaN(Date.parse(occurredRaw)) ? new Date(occurredRaw).toISOString() : null;
  return {
    eventId: str(data.id) ?? `sha256:${createHash("sha256").update(rawBody).digest("hex")}`,
    event: {
      type,
      callControlId: str(payload.call_control_id),
      role,
      occurredAt,
      hangupCause: str(payload.hangup_cause),
    },
    claimedCallId: claimed && UUID.test(claimed) ? claimed.toLowerCase() : null,
    occurredAt,
    raw: parsed,
  };
}

async function resolveRow(store: DirectCallStore, event: DirectCallEvent, claimedCallId: string | null): Promise<DirectCallFullRow | null> {
  if (event.callControlId) {
    const byLeg = await store.findByLeg(event.callControlId);
    if (byLeg) return byLeg;
  }
  // The leg id is not stored yet (Dial response still in flight): fall back to our own client_state.
  if (claimedCallId && event.role) return store.findById(claimedCallId);
  return null;
}

async function safeHangup(deps: WebhookDeps, callControlId: string, commandId: string) {
  try {
    await deps.hangup(callControlId, commandId);
  } catch (error) {
    deps.report(error, "direct_call_hangup");
  }
}

async function failCall(deps: WebhookDeps, rowId: string, patch: { failure_reason: string; seller_dial_state?: "unknown" }) {
  return deps.store.updateIfStatus(rowId, LIVE, {
    status: "failed",
    ended_at: deps.now().toISOString(),
    browser_hangup_pending: true,
    ...patch,
  });
}

async function runSellerDial(deps: WebhookDeps, row: DirectCallFullRow, command: SellerDialCommand) {
  let dialed: { callControlId: string };
  try {
    dialed = await deps.dial({
      to: command.to,
      from: command.from,
      linkTo: command.linkTo,
      commandId: command.commandId,
      timeoutSecs: command.timeoutSecs,
      timeLimitSecs: command.timeLimitSecs,
      clientState: command.clientState,
      bridgeOnAnswer: command.bridgeOnAnswer,
      bridgeIntent: command.bridgeIntent,
    });
  } catch (error) {
    deps.report(error, "direct_call_seller_dial");
    const unknown = !(error instanceof TelnyxApiError) || error.kind === "unknown";
    // Never re-send a Dial whose result is unknown; end the call and drop the browser leg
    // (persisted as pending teardown, retried until the provider confirms).
    const failed = await failCall(
      deps,
      row.id,
      unknown ? { failure_reason: "dial_outcome_unknown", seller_dial_state: "unknown" } : { failure_reason: "seller_dial_rejected" },
    );
    if (!failed) await deps.store.setLegCleanup(row.id, "browser", true);
    return;
  }
  await deps.store.setSellerLegIfNull(row.id, dialed.callControlId);
  const current = await deps.store.findById(row.id);
  if (current?.seller_leg_id !== dialed.callControlId) {
    // A different seller leg id is already stored (it cannot be this Dial's leg): this one is an orphan.
    await safeHangup(deps, dialed.callControlId, hangupId(row.id, dialed.callControlId));
    return;
  }
  // A call.initiated that stored the same id first is success, not a conflict.
  await deps.store.markSellerDialSent(row.id);
  // The call ended while the Dial was in flight: the new leg must not linger.
  if (DIRECT_CALL_TERMINAL_STATUSES.has(current.status) || current.status === "ending") {
    await deps.store.setLegCleanup(row.id, "seller", true);
  }
}

function hangupId(rowId: string, legId: string) {
  return hangupCommandId(rowId, legId);
}

async function runCommands(deps: WebhookDeps, row: DirectCallFullRow, commands: DirectCommand[]) {
  for (const command of commands) await runSellerDial(deps, row, command);
}

/** Thrown after the event is stored when a leg is still not confirmed ended, so the route answers 500 and Telnyx redelivers. */
export class LegCleanupPendingError extends Error {
  constructor() {
    super("Direct call leg teardown is not confirmed yet.");
    this.name = "LegCleanupPendingError";
  }
}

async function settleCleanup(deps: WebhookDeps, rowId: string): Promise<boolean> {
  const fresh = await deps.store.findById(rowId);
  if (!fresh) return true;
  const result = await runLegCleanup({ store: deps.store, hangup: deps.hangup, report: deps.report }, fresh);
  return !result.pending;
}

/** Persist-then-act. Throws on database failure so the route can answer 500 and Telnyx retries. */
export async function processDirectCallWebhook(rawBody: string, deps: WebhookDeps): Promise<WebhookOutcome> {
  const parsed = parseDirectEvent(rawBody);
  if (!parsed) return { status: 200, result: "stored_only" };
  const { store } = deps;
  let row = await resolveRow(store, parsed.event, parsed.claimedCallId);

  const inserted = await store.insertEvent({
    provider_event_id: parsed.eventId,
    direct_call_id: row?.id ?? null,
    event_type: parsed.event.type,
    occurred_at: parsed.occurredAt,
    payload: parsed.raw,
  });
  if (inserted === "duplicate_processed") {
    // No new transition, but retry any teardown that was left pending.
    if (row) await settleCleanup(deps, row.id).catch((error) => deps.report(error, "direct_call_cleanup"));
    return { status: 200, result: "duplicate" };
  }

  if (!row) {
    await store.markEventProcessed(parsed.eventId, null);
    return { status: 200, result: "stored_only" };
  }

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS && row; attempt++) {
    const transition = nextDirectCallState(row, parsed.event, deps.now());
    if (!transition.patch) {
      await runCommands(deps, row, transition.commands);
      break;
    }
    const updated = await store.updateIfStatus(row.id, [row.status], transition.patch);
    if (updated) {
      await runCommands(deps, updated, transition.commands);
      break;
    }
    row = await store.findById(row.id); // status moved under us; re-evaluate against fresh state
  }
  if (row && !(await settleCleanup(deps, row.id))) throw new LegCleanupPendingError();
  await store.markEventProcessed(parsed.eventId, row?.id ?? null);
  return { status: 200, result: "processed" };
}
