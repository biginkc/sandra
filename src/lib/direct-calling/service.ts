import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";

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
import { MAX_CALL_SECS, deterministicCommandId } from "./transitions";

type PrepareResult = { ok: true; data: { propertyId: string | null; contactId: string | null; phoneE164: string } } | { ok: false; error: string };

export type DirectCallServiceDeps = {
  store: DirectCallStore;
  env: DirectCallEnv;
  now: () => Date;
  prepareLeadCall: (propertyId: string) => Promise<PrepareResult>;
  prepareManualCall: (phone: string) => Promise<PrepareResult>;
  resumeFailedSoftphoneCall: (propertyId: string) => Promise<void>;
  telnyx: {
    dial: (settings: TelnyxDirectSettings, params: DialParams) => Promise<{ callControlId: string }>;
    hangup: (settings: TelnyxDirectSettings, callControlId: string, commandId: string) => Promise<void>;
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

  function startResult(row: DirectCallFullRow): StartDirectCallResult | null {
    if (!row.browser_leg_id) return null;
    return {
      directCallId: row.id,
      browserLegId: row.browser_leg_id,
      correlationHeader: { name: "X-Sandra-Direct-Call-Id", value: row.id },
    };
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
        const replay = !DIRECT_CALL_TERMINAL_STATUSES.has(prior.status) ? startResult(prior) : null;
        return replay ? { ok: true, data: replay } : err("This call request was already used.", "duplicate_request");
      }
      await store.expireStale(userId, deps.now());
      if (await store.findActiveForUser(userId)) return err("You already have a call in progress.", "call_in_progress");
      await ensureOperator(userId, settings);
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
      const operator = await store.getOperator(userId);
      if (!operator) throw new Error("operator credential missing");
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
        return err("You already have a call in progress.", "call_in_progress");
      }
      row = inserted.row;
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
      return { ok: true, data: { directCallId: row.id, browserLegId: dialed.callControlId, correlationHeader: { name: "X-Sandra-Direct-Call-Id", value: row.id } } };
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

  async function getStatus(userId: string, directCallId: string): Promise<DirectActionResult<DirectCallStatusView>> {
    if (typeof directCallId !== "string" || !UUID.test(directCallId)) return err("Call not found.", "not_found");
    try {
      const row = await store.findOwned(directCallId.toLowerCase(), userId);
      if (!row) return err("Call not found.", "not_found");
      return {
        ok: true,
        data: {
          directCallId: row.id,
          status: row.status as DirectCallStatus,
          connectedAt: row.connected_at,
          endedAt: row.ended_at,
          hangupCause: row.hangup_cause,
          failureReason: row.failure_reason,
        },
      };
    } catch (error) {
      deps.report(error, "direct_call_status");
      return err("Could not read the call status.", "status_failed");
    }
  }

  async function control(userId: string, directCallId: string, ctl: DirectCallControl): Promise<DirectActionResult<{ accepted: true }>> {
    const allowed = gate(userId);
    if (!allowed.ok) return allowed;
    if (typeof directCallId !== "string" || !UUID.test(directCallId)) return err("Call not found.", "not_found");
    try {
      const row = await store.findOwned(directCallId.toLowerCase(), userId);
      if (!row) return err("Call not found.", "not_found");

      if (ctl?.action === "dtmf") {
        if (typeof ctl.digit !== "string" || !DTMF.test(ctl.digit)) return err("Invalid digit.", "invalid_request");
        if (row.status !== "connected" || !row.seller_leg_id) return err("The call is not connected.", "not_connected");
        await deps.telnyx.sendDtmf(allowed.settings, row.seller_leg_id, ctl.digit);
        return { ok: true, data: { accepted: true } };
      }
      if (ctl?.action !== "hangup") return err("Unsupported control.", "invalid_request");

      if (DIRECT_CALL_TERMINAL_STATUSES.has(row.status)) return { ok: true, data: { accepted: true } };
      if (row.status !== "ending") await store.updateIfStatus(row.id, SETUP_STATUSES, { status: "ending" });
      const legs = [row.browser_leg_id, row.seller_leg_id].filter((leg): leg is string => Boolean(leg));
      let succeeded = 0;
      for (const leg of legs) {
        try {
          await deps.telnyx.hangup(allowed.settings, leg, deterministicCommandId(`${row.id}:${leg}:hangup`));
          succeeded += 1;
        } catch (error) {
          deps.report(error, "direct_call_hangup");
        }
      }
      if (legs.length > 0 && succeeded === 0) return err("Could not hang up. Try again.", "hangup_failed");
      return { ok: true, data: { accepted: true } };
    } catch (error) {
      deps.report(error, "direct_call_control");
      return err("Could not control the call.", "control_failed");
    }
  }

  return { getRtcToken, startCall, getStatus, control };
}
