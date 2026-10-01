import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";

import { processDueCleanups, type CleanupResult } from "./cleanup";
import { resumeAfterTransition, resumeLeadIfUnowned } from "./lead-resume";
import { readTelnyxDirectSettings, resolveCallingConfig, type DirectCallEnv, type TelnyxDirectSettings } from "./config";
import {
  DIRECT_CALL_TERMINAL_STATUSES,
  type CancelDirectCallResult,
  type DirectActionResult,
  type DirectCallControl,
  type DirectCallStatus,
  type DirectCallStatusView,
  type DirectCallTarget,
  type DirectRtcToken,
  type StartDirectCallInput,
  type StartDirectCallResult,
} from "./contract";
import type { DirectCallFullRow, DirectCallStore } from "./store";
import { TelnyxApiError, type ActiveCall, type DialParams } from "./telnyx";
import { MAX_CALL_SECS, TEARDOWN_PENDING, staleOutcome, teardownBegun, type CleanupSpec } from "./transitions";

type PrepareResult = { ok: true; data: DirectCallTarget } | { ok: false; error: string };

export type DirectCallServiceDeps = {
  store: DirectCallStore;
  env: DirectCallEnv;
  now: () => Date;
  prepareLeadCall: (propertyId: string) => Promise<PrepareResult>;
  prepareManualCall: (phone: string) => Promise<PrepareResult>;
  resumeFailedSoftphoneCall: (propertyId: string) => Promise<void>;
  /**
   * Seals the same call identity the Jitter path mints for wrap-up. `capability` is null when no
   * signing key is configured; `training` marks the dedicated internal-training number.
   */
  sealCallIdentity: (args: { callId: string; userId: string; phoneE164: string }) => { capability: string | null; training: boolean };
  telnyx: {
    dial: (settings: TelnyxDirectSettings, params: DialParams) => Promise<{ callControlId: string }>;
    hangup: (settings: TelnyxDirectSettings, callControlId: string, commandId: string) => Promise<void>;
    getCall: (settings: TelnyxDirectSettings, callControlId: string) => Promise<{ isAlive: boolean }>;
    listActiveCalls: (settings: TelnyxDirectSettings) => Promise<{ calls: ActiveCall[]; complete: boolean }>;
    sendDtmf: (settings: TelnyxDirectSettings, callControlId: string, digit: string) => Promise<void>;
    createCredential: (settings: TelnyxDirectSettings, name: string) => Promise<{ id: string; sipUsername: string }>;
    createToken: (settings: TelnyxDirectSettings, credentialId: string) => Promise<string>;
  };
  report: (error: unknown, tag: string) => void;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DTMF = /^[0-9*#]$/;
const SETUP_STATUSES: DirectCallStatus[] = ["browser_connecting", "seller_dialing", "connected"];
const LIVE: DirectCallStatus[] = [...SETUP_STATUSES, "ending"];
const CANCELLED_BEFORE_START = "cancelled_before_start";

function err(error: string, errorCode?: string): { ok: false; error: string; errorCode?: string } {
  return errorCode ? { ok: false, error, errorCode } : { ok: false, error };
}

export function createDirectCallService(deps: DirectCallServiceDeps) {
  const { store, env } = deps;

  function gate(userId: string): { ok: true; settings: TelnyxDirectSettings } | ReturnType<typeof err> {
    const settings = readTelnyxDirectSettings(env);
    if (resolveCallingConfig(userId, env).transport !== "telnyx_direct" || !settings) {
      return err("Direct calling is not enabled for this account.", "not_enabled");
    }
    return { ok: true, settings };
  }

  async function ensureOperator(userId: string, settings: TelnyxDirectSettings) {
    const existing = await store.getOperator(userId);
    if (existing) return existing;
    const created = await deps.telnyx.createCredential(settings, `sandra-direct-${userId}`);
    return store.insertOperator({
      user_id: userId,
      org_id: SANDRA_ORG_ID,
      telnyx_credential_id: created.id,
      sip_username: created.sipUsername,
    });
  }

  async function getRtcToken(userId: string): Promise<DirectActionResult<DirectRtcToken>> {
    const allowed = gate(userId);
    if (!allowed.ok) return allowed;
    try {
      const operator = await ensureOperator(userId, allowed.settings);
      const token = await deps.telnyx.createToken(allowed.settings, operator.telnyx_credential_id);
      return { ok: true, data: { token, sipUsername: operator.sip_username } };
    } catch (error) {
      deps.report(error, "direct_call_token");
      return err("Could not prepare the phone line. Try again.", "token_failed");
    }
  }

  /** Resume a lead's enrollments (existing session-bound function), unless another direct call owns them. */
  async function resume(propertyId: string | null, userId: string, excludeCallId: string | null) {
    await resumeLeadIfUnowned(
      { store, resume: (id) => deps.resumeFailedSoftphoneCall(id), report: deps.report },
      propertyId,
      userId,
      excludeCallId,
    );
  }

  function startResult(row: DirectCallFullRow, userId: string): StartDirectCallResult | null {
    if (!row.browser_leg_id) return null;
    const { capability } = deps.sealCallIdentity({ callId: row.id, userId, phoneE164: row.destination_e164 });
    return {
      directCallId: row.id,
      browserLegId: row.browser_leg_id,
      correlationHeader: { name: "X-Sandra-Direct-Call-Id", value: row.id },
      ...(capability ? { callCapability: capability } : {}),
    };
  }

  const cleanupDeps = (settings: TelnyxDirectSettings) => ({
    store,
    hangup: (callControlId: string, commandId: string) => deps.telnyx.hangup(settings, callControlId, commandId),
    getCall: (callControlId: string) => deps.telnyx.getCall(settings, callControlId),
    listActiveCalls: () => deps.telnyx.listActiveCalls(settings),
    now: deps.now,
    report: deps.report,
  });

  /** Work every cleanup obligation of the operator that is due. Never throws: the rows are durable. */
  async function runCleanups(settings: TelnyxDirectSettings, userId: string): Promise<CleanupResult | null> {
    try {
      return await processDueCleanups(cleanupDeps(settings), userId);
    } catch (error) {
      deps.report(error, "direct_call_cleanup");
      return null;
    }
  }

  const legSpecs = (row: DirectCallFullRow): CleanupSpec[] =>
    [row.browser_leg_id, row.seller_leg_id].filter((id): id is string => Boolean(id)).map((legId) => ({ kind: "leg", legId }));

  /**
   * Drives a stale call down before it may release the operator lock, and works any due cleanup.
   * Never marks a call terminal while a cleanup obligation of it is unconfirmed.
   */
  async function settle(row: DirectCallFullRow, settings: TelnyxDirectSettings | null): Promise<DirectCallFullRow> {
    try {
      let current = row;
      if (staleOutcome(current, deps.now()) && current.failure_reason !== TEARDOWN_PENDING) {
        current =
          (await store.updateIfStatus(current.id, [current.status], { failure_reason: TEARDOWN_PENDING }, legSpecs(current))) ??
          (await store.findById(current.id)) ??
          current;
      }
      if (settings) await runCleanups(settings, current.operator_user_id);
      const fresh = (await store.findById(current.id)) ?? current;
      const outcome = staleOutcome(fresh, deps.now());
      if (outcome && !DIRECT_CALL_TERMINAL_STATUSES.has(fresh.status) && (await store.openCleanupsForCall(fresh.id)).length === 0) {
        const moved = await store.updateIfStatus(fresh.id, [fresh.status], {
          status: outcome,
          ended_at: deps.now().toISOString(),
          failure_reason: outcome === "failed" ? "stale_unresolved" : null,
        });
        await resumeAfterTransition({ store, resume: (id) => deps.resumeFailedSoftphoneCall(id), report: deps.report }, fresh, moved);
        return moved ?? (await store.findById(fresh.id)) ?? fresh;
      }
      return fresh;
    } catch (error) {
      deps.report(error, "direct_call_settle");
      return row;
    }
  }

  async function startCall(userId: string, input: StartDirectCallInput): Promise<DirectActionResult<StartDirectCallResult>> {
    const allowed = gate(userId);
    if (!allowed.ok) return allowed;
    const { settings } = allowed;

    if (!input || typeof input.clientRequestId !== "string" || !UUID.test(input.clientRequestId)) {
      return err("A valid call request id is required.", "invalid_request");
    }
    if (input.kind === "lead") {
      if (typeof input.propertyId !== "string" || !input.propertyId.trim() || input.propertyId.length > 200) {
        return err("A valid lead is required.", "invalid_request");
      }
    } else if (input.kind === "manual") {
      if (typeof input.phone !== "string" || !input.phone.trim() || input.phone.length > 40) {
        return err("Enter a valid phone number.", "invalid_request");
      }
    } else {
      return err("A valid call target is required.", "invalid_request");
    }
    const clientRequestId = input.clientRequestId.toLowerCase();

    try {
      const prior = await store.findByRequest(userId, clientRequestId);
      if (prior) {
        if (prior.failure_reason === CANCELLED_BEFORE_START) return err("This call was cancelled.", "cancelled");
        const replay = !DIRECT_CALL_TERMINAL_STATUSES.has(prior.status) ? startResult(prior, userId) : null;
        return replay ? { ok: true, data: replay } : err("This call request was already used.", "duplicate_request");
      }
      // A stuck row is torn down (legs hung up) and due cleanups are worked before the operator may start.
      const existing = await store.findActiveForUser(userId);
      if (existing) await settle(existing, settings);
      await runCleanups(settings, userId);
    } catch (error) {
      deps.report(error, "direct_call_start_precheck");
      return err("Could not start the call. Try again.", "start_failed");
    }

    // RESERVE first: the atomic busy check (a non-terminal call or any unconfirmed cleanup row) happens
    // here, before prepare, so prepare (which pauses lead enrollments) only ever runs for a call that is
    // allowed to proceed. The call is only dialed once its prepared target is stored.
    let row: DirectCallFullRow;
    try {
      const begun = await store.beginCall({
        org_id: SANDRA_ORG_ID,
        operator_user_id: userId,
        property_id: null,
        contact_id: null,
        destination_e164: "",
        caller_id_e164: settings.callerIdE164,
        client_request_id: clientRequestId,
      });
      if (begun.outcome === "duplicate_request") {
        if (begun.row.failure_reason === CANCELLED_BEFORE_START) return err("This call was cancelled.", "cancelled");
        const replay = !DIRECT_CALL_TERMINAL_STATUSES.has(begun.row.status) ? startResult(begun.row, userId) : null;
        return replay ? { ok: true, data: replay } : err("This call request was already used.", "duplicate_request");
      }
      if (begun.outcome === "busy_cleanup") return err("Your previous call is still hanging up. Try again in a moment.", "teardown_pending");
      if (begun.outcome === "busy_call") return err("You already have a call in progress.", "call_in_progress");
      row = (begun as Extract<typeof begun, { outcome: "created" }>).row;
    } catch (error) {
      deps.report(error, "direct_call_start_reserve");
      return err("Could not start the call. Try again.", "start_failed");
    }

    // Existing eligibility path, unchanged. Its error text is returned as-is.
    let prepared: Awaited<ReturnType<typeof deps.prepareLeadCall>>;
    try {
      prepared = input.kind === "lead" ? await deps.prepareLeadCall(input.propertyId) : await deps.prepareManualCall(input.phone);
    } catch (error) {
      deps.report(error, "direct_call_prepare");
      prepared = { ok: false, error: "Could not start the call. Try again." };
    }
    if (!prepared.ok) {
      await store.discardReservation(row.id).catch((e) => deps.report(e, "direct_call_start_discard"));
      return { ok: false, error: prepared.error };
    }
    const target = prepared.data;

    let dialedLeg: string | null = null;
    let dialRefused = false;
    try {
      const operator = await ensureOperator(userId, settings);
      await store.setTarget(row.id, { property_id: target.propertyId, contact_id: target.contactId, destination_e164: target.phoneE164 });
      const identity = deps.sealCallIdentity({ callId: row.id, userId, phoneE164: target.phoneE164 });
      if (identity.training && !identity.capability) {
        const moved = await store.updateIfStatus(row.id, LIVE, { status: "failed", failure_reason: "capability_unavailable", ended_at: deps.now().toISOString() });
        await store.dialRejected(row.id, "browser"); // nothing was dialed
        if (moved) await resume(target.propertyId, userId, row.id);
        return err("Internal training is unavailable.", "start_failed");
      }
      // A cancel that raced ahead of this start (tombstone / hangup before the Dial) wins: dial nothing.
      const latest = await store.findById(row.id);
      if (!latest || latest.status !== "browser_connecting") {
        if (latest) await store.dialRejected(row.id, "browser");
        await resume(target.propertyId, userId, row.id);
        return err("This call was cancelled.", "cancelled");
      }
      const dialed = await deps.telnyx.dial(settings, {
        to: `sip:${operator.sip_username}@sip.telnyx.com`,
        from: settings.callerIdE164,
        clientState: { directCallId: row.id, role: "browser" },
        commandId: row.browser_command_id,
        timeoutSecs: 30,
        timeLimitSecs: MAX_CALL_SECS,
        customHeaders: [{ name: "X-Sandra-Direct-Call-Id", value: row.id }],
      });
      dialedLeg = dialed.callControlId;
      // Stores the leg and resolves the browser Dial's unresolved row (or queues the leg for hangup if
      // the call was already ended meanwhile).
      await store.dialSucceeded(row.id, dialed.callControlId, "browser");
      const current = await store.findById(row.id);
      if (current && DIRECT_CALL_TERMINAL_STATUSES.has(current.status)) return err("Could not start the call. Try again.", "start_failed");
      return {
        ok: true,
        data: {
          directCallId: row.id,
          browserLegId: dialed.callControlId,
          correlationHeader: { name: "X-Sandra-Direct-Call-Id", value: row.id },
          ...(identity.capability ? { callCapability: identity.capability } : {}),
          target,
        },
      };
    } catch (error) {
      deps.report(error, "direct_call_start");
      dialRefused = !dialedLeg && error instanceof TelnyxApiError && error.kind === "rejected";
      const unknown = !dialedLeg && !dialRefused;
      try {
        // The unresolved_dial row written with the reservation stays open when the outcome is unknown; a leg
        // we know but could not store becomes a durable leg row; a definitive refusal resolves it.
        const moved = await store.updateIfStatus(
          row.id,
          LIVE,
          { status: "failed", failure_reason: dialRefused ? "browser_dial_rejected" : "dial_outcome_unknown", ended_at: deps.now().toISOString() },
          dialedLeg ? [{ kind: "leg", legId: dialedLeg }] : [],
        );
        if (dialRefused) await store.dialRejected(row.id, "browser");
        void moved;
        if (unknown || dialedLeg) await runCleanups(settings, userId);
      } catch (markError) {
        deps.report(markError, "direct_call_start_mark_failed");
      }
      await resume(target.propertyId, userId, row.id);
      return err("Could not start the call. Try again.", "start_failed");
    }
  }

  async function statusView(row: DirectCallFullRow): Promise<DirectCallStatusView> {
    const terminal = DIRECT_CALL_TERMINAL_STATUSES.has(row.status);
    // Derived from unconfirmed cleanup rows. An unresolved Dial of a still-live call is not "cleanup".
    const open = await store.openCleanupsForCall(row.id);
    const cleanupPending = open.some((r) => r.kind === "leg" || teardownBegun(row));
    return {
      directCallId: row.id,
      status: row.status as DirectCallStatus,
      connectedAt: row.connected_at,
      endedAt: row.ended_at,
      hangupCause: row.hangup_cause,
      // A call can be over while a leg is still being torn down; say so rather than hide it.
      failureReason: terminal && cleanupPending && !row.failure_reason ? TEARDOWN_PENDING : row.failure_reason,
      cleanupPending,
    };
  }

  // Status of an owned call needs only authentication + ownership: removing a user from the pilot
  // must not strand their live call.
  async function getStatus(userId: string, directCallId: string): Promise<DirectActionResult<DirectCallStatusView>> {
    if (typeof directCallId !== "string" || !UUID.test(directCallId)) return err("Call not found.", "not_found");
    try {
      const row = await store.findOwned(directCallId.toLowerCase(), userId);
      if (!row) return err("Call not found.", "not_found");
      return { ok: true, data: await statusView(await settle(row, readTelnyxDirectSettings(env))) };
    } catch (error) {
      deps.report(error, "direct_call_status");
      return err("Could not read the call status.", "status_failed");
    }
  }

  /** Same as getStatus, keyed by the client request id (for a start whose response was lost). */
  async function getStatusByRequest(userId: string, clientRequestId: string): Promise<DirectActionResult<DirectCallStatusView>> {
    if (typeof clientRequestId !== "string" || !UUID.test(clientRequestId)) return err("Call not found.", "not_found");
    try {
      const row = await store.findByRequest(userId, clientRequestId.toLowerCase());
      if (!row) return err("Call not found.", "not_found");
      return { ok: true, data: await statusView(await settle(row, readTelnyxDirectSettings(env))) };
    } catch (error) {
      deps.report(error, "direct_call_status");
      return err("Could not read the call status.", "status_failed");
    }
  }

  async function control(userId: string, directCallId: string, ctl: DirectCallControl): Promise<DirectActionResult<{ accepted: true }>> {
    if (typeof directCallId !== "string" || !UUID.test(directCallId)) return err("Call not found.", "not_found");
    try {
      const row = await store.findOwned(directCallId.toLowerCase(), userId);
      if (!row) return err("Call not found.", "not_found");

      if (ctl?.action === "dtmf") {
        const allowed = gate(userId);
        if (!allowed.ok) return allowed;
        if (typeof ctl.digit !== "string" || !DTMF.test(ctl.digit)) return err("Invalid digit.", "invalid_request");
        if (row.status !== "connected" || !row.seller_leg_id) return err("The call is not connected.", "not_connected");
        await deps.telnyx.sendDtmf(allowed.settings, row.seller_leg_id, ctl.digit);
        return { ok: true, data: { accepted: true } };
      }
      if (ctl?.action !== "hangup") return err("Unsupported control.", "invalid_request");
      return await hangupRow(userId, row);
    } catch (error) {
      deps.report(error, "direct_call_control");
      return err("Could not control the call.", "control_failed");
    }
  }

  // Hangup of an owned call needs only authentication + ownership (not pilot membership).
  async function hangupRow(userId: string, row: DirectCallFullRow): Promise<DirectActionResult<{ accepted: true }>> {
    const settings = readTelnyxDirectSettings(env);
    if (!DIRECT_CALL_TERMINAL_STATUSES.has(row.status) && row.status !== "ending") {
      // Moves to ending and persists a cleanup row per known leg in one write. A seller Dial still in
      // flight already has its unresolved_dial row, which becomes actionable now.
      await store.updateIfStatus(row.id, SETUP_STATUSES, { status: "ending" }, legSpecs(row));
    }
    // Without provider credentials the obligation is recorded (the operator stays locked) but cannot be worked.
    if (!settings) return err("Could not hang up. Try again.", "hangup_failed");
    const result = await runCleanups(settings, userId);
    if (result && result.failed > 0 && result.confirmed === 0 && result.acknowledged === 0) return err("Could not hang up. Try again.", "hangup_failed");
    return { ok: true, data: { accepted: true } };
  }

  /**
   * Cancels a start whose outcome the browser does not know. A call that exists goes through the normal
   * hangup path; if none exists a terminal tombstone is recorded so a late start with that id dials nothing.
   */
  async function cancelByRequest(userId: string, clientRequestId: string): Promise<DirectActionResult<CancelDirectCallResult>> {
    if (typeof clientRequestId !== "string" || !UUID.test(clientRequestId)) return err("A valid call request id is required.", "invalid_request");
    try {
      const cancelled = await store.cancelRequest(userId, SANDRA_ORG_ID, clientRequestId.toLowerCase());
      if (cancelled.outcome === "tombstoned") return { ok: true, data: { directCallId: null, tombstoned: true } };
      const hung = await hangupRow(userId, cancelled.row);
      if (!hung.ok) return hung;
      return { ok: true, data: { directCallId: cancelled.row.id, tombstoned: false } };
    } catch (error) {
      deps.report(error, "direct_call_cancel");
      return err("Could not cancel the call.", "cancel_failed");
    }
  }

  return { getRtcToken, startCall, getStatus, getStatusByRequest, control, cancelByRequest };
}
