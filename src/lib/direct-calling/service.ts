import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";

import { runLegCleanup } from "./cleanup";
import { readTelnyxDirectSettings, resolveCallingConfig, type DirectCallEnv, type TelnyxDirectSettings } from "./config";
import {
  DIRECT_CALL_TERMINAL_STATUSES,
  type DirectActionResult,
  type DirectCallControl,
  type DirectCallStatus,
  type DirectCallStatusView,
  type DirectRtcToken,
  type StartDirectCallInput,
  type StartDirectCallResult,
} from "./contract";
import type { DirectCallFullRow, DirectCallStore } from "./store";
import { TelnyxApiError, type DialParams } from "./telnyx";
import { MAX_CALL_SECS, TEARDOWN_PENDING, hasPendingCleanup, staleOutcome } from "./transitions";

type PrepareResult = { ok: true; data: { propertyId: string | null; contactId: string | null; phoneE164: string } } | { ok: false; error: string };

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

  async function resume(propertyId: string | null) {
    if (!propertyId) return;
    try {
      await deps.resumeFailedSoftphoneCall(propertyId);
    } catch (error) {
      deps.report(error, "direct_call_resume");
    }
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
    now: deps.now,
    report: deps.report,
  });

  /**
   * Drives a stale call's legs down before it is allowed to release the operator lock, and
   * retries any leg teardown that is still pending. Never marks a call terminal while a known
   * leg has not been confirmed ended.
   */
  async function settle(row: DirectCallFullRow, settings: TelnyxDirectSettings | null): Promise<DirectCallFullRow> {
    if (!settings) return row;
    try {
      let current = row;
      const outcome = staleOutcome(current, deps.now());
      if (outcome) {
        if (current.failure_reason !== TEARDOWN_PENDING) {
          current =
            (await store.updateIfStatus(current.id, [current.status], {
              failure_reason: TEARDOWN_PENDING,
              browser_hangup_pending: Boolean(current.browser_leg_id),
              seller_hangup_pending: Boolean(current.seller_leg_id),
            })) ?? (await store.findById(current.id)) ?? current;
        }
        if (!DIRECT_CALL_TERMINAL_STATUSES.has(current.status)) {
          await runLegCleanup(cleanupDeps(settings), current);
          const fresh = (await store.findById(current.id)) ?? current;
          if (!hasPendingCleanup(fresh) && !DIRECT_CALL_TERMINAL_STATUSES.has(fresh.status)) {
            return (
              (await store.updateIfStatus(fresh.id, [fresh.status], {
                status: outcome,
                ended_at: deps.now().toISOString(),
                failure_reason: outcome === "failed" ? "stale_unresolved" : null,
              })) ?? (await store.findById(fresh.id)) ?? fresh
            );
          }
          return fresh;
        }
        return current;
      }
      if (hasPendingCleanup(current)) {
        await runLegCleanup(cleanupDeps(settings), current);
        return (await store.findById(current.id)) ?? current;
      }
      return current;
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
        const replay = !DIRECT_CALL_TERMINAL_STATUSES.has(prior.status) ? startResult(prior, userId) : null;
        return replay ? { ok: true, data: replay } : err("This call request was already used.", "duplicate_request");
      }
      const existing = await store.findActiveForUser(userId);
      if (existing) {
        // A stuck row is torn down (legs hung up) before it may release the operator.
        const settled = await settle(existing, settings);
        if (!DIRECT_CALL_TERMINAL_STATUSES.has(settled.status)) return err("You already have a call in progress.", "call_in_progress");
        // The call is over but a leg is not yet confirmed ended: the operator lock still holds.
        if (hasPendingCleanup(settled)) return err("Your previous call is still hanging up. Try again in a moment.", "teardown_pending");
      }
    } catch (error) {
      deps.report(error, "direct_call_start_precheck");
      return err("Could not start the call. Try again.", "start_failed");
    }

    // Existing eligibility path, unchanged. Its error text is returned as-is.
    const prepared = input.kind === "lead" ? await deps.prepareLeadCall(input.propertyId) : await deps.prepareManualCall(input.phone);
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const target = prepared.data;

    let row: DirectCallFullRow | null = null;
    try {
      const operator = await ensureOperator(userId, settings);
      const inserted = await store.insertCall({
        org_id: SANDRA_ORG_ID,
        operator_user_id: userId,
        property_id: target.propertyId,
        contact_id: target.contactId,
        destination_e164: target.phoneE164,
        caller_id_e164: settings.callerIdE164,
        client_request_id: clientRequestId,
      });
      if (inserted === "conflict") {
        const active = await store.findActiveForUser(userId);
        // The winning call owns the enrollment pause when it is for the same lead.
        if (!active || active.property_id !== target.propertyId) await resume(target.propertyId);
        if (active && DIRECT_CALL_TERMINAL_STATUSES.has(active.status)) {
          return err("Your previous call is still hanging up. Try again in a moment.", "teardown_pending");
        }
        return err("You already have a call in progress.", "call_in_progress");
      }
      row = inserted.row;
      const identity = deps.sealCallIdentity({ callId: row.id, userId, phoneE164: target.phoneE164 });
      if (identity.training && !identity.capability) {
        await store.updateIfStatus(row.id, LIVE, { status: "failed", failure_reason: "capability_unavailable", ended_at: deps.now().toISOString() });
        await resume(target.propertyId);
        return err("Internal training is unavailable.", "start_failed");
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
      await store.setBrowserLeg(row.id, dialed.callControlId);
      return {
        ok: true,
        data: {
          directCallId: row.id,
          browserLegId: dialed.callControlId,
          correlationHeader: { name: "X-Sandra-Direct-Call-Id", value: row.id },
          ...(identity.capability ? { callCapability: identity.capability } : {}),
        },
      };
    } catch (error) {
      deps.report(error, "direct_call_start");
      if (row) {
        const unknown = !(error instanceof TelnyxApiError) || error.kind === "unknown";
        try {
          await store.updateIfStatus(row.id, LIVE, {
            status: "failed",
            failure_reason: unknown ? "dial_outcome_unknown" : "browser_dial_rejected",
            ended_at: deps.now().toISOString(),
          });
        } catch (markError) {
          deps.report(markError, "direct_call_start_mark_failed");
        }
      }
      await resume(target.propertyId);
      return err("Could not start the call. Try again.", "start_failed");
    }
  }

  function statusView(row: DirectCallFullRow): DirectCallStatusView {
    const terminal = DIRECT_CALL_TERMINAL_STATUSES.has(row.status);
    return {
      directCallId: row.id,
      status: row.status as DirectCallStatus,
      connectedAt: row.connected_at,
      endedAt: row.ended_at,
      hangupCause: row.hangup_cause,
      // A call can be over while a leg is still being torn down; say so rather than hide it.
      failureReason: terminal && hasPendingCleanup(row) && !row.failure_reason ? TEARDOWN_PENDING : row.failure_reason,
      cleanupPending: hasPendingCleanup(row),
    };
  }

  // Status of an owned call needs only authentication + ownership: removing a user from the pilot
  // must not strand their live call.
  async function getStatus(userId: string, directCallId: string): Promise<DirectActionResult<DirectCallStatusView>> {
    if (typeof directCallId !== "string" || !UUID.test(directCallId)) return err("Call not found.", "not_found");
    try {
      const row = await store.findOwned(directCallId.toLowerCase(), userId);
      if (!row) return err("Call not found.", "not_found");
      return { ok: true, data: statusView(await settle(row, readTelnyxDirectSettings(env))) };
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

      // Hangup of an owned call needs only authentication + ownership (not pilot membership).
      const settings = readTelnyxDirectSettings(env);
      if (!settings) return err("Could not hang up. Try again.", "hangup_failed");

      let current = row;
      if (!DIRECT_CALL_TERMINAL_STATUSES.has(current.status) && current.status !== "ending") {
        const moved = await store.updateIfStatus(current.id, SETUP_STATUSES, {
          status: "ending",
          browser_hangup_pending: Boolean(current.browser_leg_id),
          seller_hangup_pending: Boolean(current.seller_leg_id),
        });
        current = moved ?? (await store.findById(current.id)) ?? current;
      }
      if (!hasPendingCleanup(current)) return { ok: true, data: { accepted: true } };
      const result = await runLegCleanup(cleanupDeps(settings), current);
      if (result.failed > 0 && result.confirmed === 0 && result.acknowledged === 0) return err("Could not hang up. Try again.", "hangup_failed");
      return { ok: true, data: { accepted: true } };
    } catch (error) {
      deps.report(error, "direct_call_control");
      return err("Could not control the call.", "control_failed");
    }
  }

  return { getRtcToken, startCall, getStatus, control };
}
