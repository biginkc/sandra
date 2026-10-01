import { createHash } from "node:crypto";

import { processDueCleanups } from "./cleanup";
import type { DirectCallStatus } from "./contract";
import type { DirectCallFullRow, DirectCallStore } from "./store";
import {
  nextDirectCallState,
  teardownBegun,
  type DirectCallEvent,
  type CleanupSpec,
  type DirectCommand,
  type LegRole,
  type SellerDialCommand,
} from "./transitions";
import { TelnyxApiError, decodeClientState, type ActiveCall, type DialParams } from "./telnyx";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CAS_ATTEMPTS = 3;
const LIVE: DirectCallStatus[] = ["browser_connecting", "seller_dialing", "connected", "ending"];

export type WebhookDeps = {
  store: DirectCallStore;
  dial: (params: DialParams) => Promise<{ callControlId: string }>;
  hangup: (callControlId: string, commandId: string) => Promise<void>;
  /** GET call status for one leg (only an explicit `isAlive:false` means gone; a 404 or any error is not proof and is never treated as gone). */
  getCall: (callControlId: string) => Promise<{ isAlive: boolean }>;
  /** Active calls on the Voice API app (reconciles unresolved Dials). */
  listActiveCalls: () => Promise<{ calls: ActiveCall[]; complete: boolean }>;
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

async function failCall(deps: WebhookDeps, row: DirectCallFullRow, patch: { failure_reason: string; seller_dial_state?: "unknown" }) {
  return deps.store.updateIfStatus(
    row.id,
    LIVE,
    { status: "failed", ended_at: deps.now().toISOString(), ...patch },
    row.browser_leg_id ? [{ kind: "leg", legId: row.browser_leg_id } satisfies CleanupSpec] : [],
  );
}

async function runSellerDial(deps: WebhookDeps, row: DirectCallFullRow, command: SellerDialCommand) {
  // No Dial may ever be issued once teardown has begun (ending/terminal/teardown_pending).
  const fresh = await deps.store.findById(row.id);
  if (!fresh || fresh.status !== "seller_dialing" || fresh.seller_dial_state !== "pending" || teardownBegun(fresh)) return;
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
    // Never re-send a Dial whose result is unknown. End the call and drop the browser leg (a durable
    // cleanup row). The unresolved_dial row written with the 'pending' transition stays open, holding
    // the operator lock until the provider has been reconciled for a leg this Dial may have created.
    // resume_pending (when due) is set atomically by this write; the operator's own session works it.
    await failCall(
      deps,
      fresh,
      unknown ? { failure_reason: "dial_outcome_unknown", seller_dial_state: "unknown" } : { failure_reason: "seller_dial_rejected" },
    );
    // The provider definitively refused it: no leg can exist, nothing to reconcile.
    if (!unknown) await deps.store.dialRejected(row.id, "seller");
    return;
  }
  // Stores the leg (or queues it for hangup if the call is over / another seller leg is stored),
  // resolving the unresolved_dial row, in one write.
  await deps.store.dialSucceeded(row.id, dialed.callControlId, "seller");
}

async function runCommands(deps: WebhookDeps, row: DirectCallFullRow, commands: DirectCommand[]) {
  for (const command of commands) await runSellerDial(deps, row, command);
}

/**
 * Works the operator's due cleanup obligations. Never throws and never decides the webhook's HTTP
 * status: the obligations are durable rows, so redelivery is not needed for them to be retried.
 */
async function triggerCleanup(deps: WebhookDeps, operatorUserId: string) {
  try {
    await processDueCleanups(
      { store: deps.store, hangup: deps.hangup, getCall: deps.getCall, listActiveCalls: deps.listActiveCalls, now: deps.now, report: deps.report },
      operatorUserId,
    );
  } catch (error) {
    deps.report(error, "direct_call_cleanup");
  }
}

/**
 * Persist-then-act. Throws on database failure of the event or its transition so the route answers
 * 500 and Telnyx redelivers. Pending cleanup never causes a 500.
 */
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
  // A provider hangup is the confirmation of any cleanup row for that leg, whichever call it is on.
  if (parsed.event.type === "call.hangup" && parsed.event.callControlId) {
    await store.confirmLegCleanup(parsed.event.callControlId, deps.now().toISOString());
  }
  if (inserted === "duplicate_processed") {
    // No new transition, but retry any cleanup that is due.
    if (row) await triggerCleanup(deps, row.operator_user_id);
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
    const updated = await store.updateIfStatus(row.id, [row.status], transition.patch, transition.cleanups);
    if (updated) {
      await runCommands(deps, updated, transition.commands);
      break;
    }
    row = await store.findById(row.id); // status moved under us; re-evaluate against fresh state
  }
  if (row) await triggerCleanup(deps, row.operator_user_id);
  await store.markEventProcessed(parsed.eventId, row?.id ?? null);
  return { status: 200, result: "processed" };
}
