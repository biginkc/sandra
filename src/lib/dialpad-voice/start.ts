"use server";

import { randomUUID } from "node:crypto";
import { bindAcquisitionCallContext } from "@/lib/my-leads/call-binding";
import { callTokenDigest } from "@/lib/my-leads/call-evidence";
import { getAcquisitionRoster } from "@/lib/my-leads/queries";
import { inspectLeadCall } from "@/lib/dialer/actions";
import { DialpadVoiceClient, DialpadVoiceError } from "./client";
import { createDialpadVoiceAdminClient } from "./database";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StartResult = { ok: true; intentId: string; status: string } | { ok: false; error: string };

/** Not mounted in the UI. All identity and destination inputs are server-owned.
 * Only authenticated webhook evidence can create acquisition activity/credit.
 */
export async function startMariaDialpadCall(input: { propertyId: string; idempotencyKey: string }): Promise<StartResult> {
  if (process.env.DIALPAD_VOICE_START_ENABLED !== "true") return { ok: false, error: "dialpad_start_disabled" };
  const orgId = process.env.DIALPAD_VOICE_ORG_ID;
  const actorId = process.env.DIALPAD_VOICE_SANDRA_USER_ID;
  const userId = process.env.DIALPAD_VOICE_USER_ID;
  const callerId = process.env.DIALPAD_VOICE_CALLER_ID;
  const deviceId = process.env.DIALPAD_VOICE_DEVICE_ID;
  const apiKey = process.env.DIALPAD_VOICE_API_KEY;
  if (!orgId || !actorId || !UUID.test(orgId) || !UUID.test(actorId) || userId !== "4904023124647936" || callerId !== "+18163706846" || !deviceId || !apiKey) return { ok: false, error: "dialpad_start_unconfigured" };
  if (!input || typeof input.propertyId !== "string" || !UUID.test(input.propertyId) || typeof input.idempotencyKey !== "string" || !UUID.test(input.idempotencyKey)) return { ok: false, error: "invalid_input" };
  try {
    const { viewer, roster } = await getAcquisitionRoster();
    if (viewer.orgId !== orgId || viewer.userId !== actorId || !roster.settings.enabled || !roster.members.some(member => member.id === actorId && member.active && member.acquisitionsEnabled)) return { ok: false, error: "forbidden" };
    const db = createDialpadVoiceAdminClient();
    const existing = await db.from("dialpad_voice_intents").select("id,property_id,status").eq("org_id", orgId).eq("actor_user_id", actorId).eq("client_idempotency_key", input.idempotencyKey).maybeSingle();
    if (existing.error) return { ok: false, error: "intent_read_failed" };
    if (existing.data) return existing.data.property_id === input.propertyId ? { ok: true, intentId: existing.data.id, status: existing.data.status } : { ok: false, error: "idempotency_conflict" };

    const provider = new DialpadVoiceClient(apiKey);
    const [devices, callerIds] = await Promise.all([provider.listUserDevices(userId), provider.getCallerId(userId)]);
    // Validated against scoped provider response. No arbitrary device fallback.
    const deviceList = devices.items;
    const numbers = callerIds.phone_numbers;
    if (!Array.isArray(deviceList) || !deviceList.some(device => device && typeof device === "object" && String(device.id) === deviceId && device.type === "web" && String(device.user_id) === userId)
      || !Array.isArray(numbers) || !numbers.includes(callerId)) return { ok: false, error: "device_or_caller_id_unavailable" };

    const prepared = await inspectLeadCall(input.propertyId);
    if (!prepared.ok || prepared.data.propertyId !== input.propertyId) return { ok: false, error: "lead_not_callable" };
    const intentId = randomUUID();
    const binding = await bindAcquisitionCallContext({ orgId, propertyId: input.propertyId, actorUserId: actorId, callToken: intentId });
    if (!binding.tracked) return { ok: false, error: "acquisition_binding_required" };
    // Scoped RPCs restore only enrollment rows unchanged since this intent's
    // pause. Never use broad resumeByProperty for failure cleanup.
    const release = async (status?: number) => {
      const result = await db.rpc("fn_release_dialpad_start", { p_intent_id: intentId, ...(status === undefined ? {} : { p_rejection_http_status: status }) });
      const data = result.data;
      return !result.error && !!data && typeof data === "object" && !Array.isArray(data) && data.released === true;
    };
    const insertion = db.from("dialpad_voice_intents").insert({ id: intentId, org_id: orgId, actor_user_id: actorId, property_id: input.propertyId, assignment_episode_id: binding.assignmentEpisodeId, binding_token_hash: callTokenDigest(intentId), dialpad_user_id: userId, destination_e164: prepared.data.phoneE164, caller_id_e164: callerId, client_idempotency_key: input.idempotencyKey }).select("id").single();
    let inserted;
    try { inserted = await insertion; } catch {
      try { await release(); } catch { /* reconcile unknown insert result */ }
      return { ok: false, error: "intent_create_unconfirmed" };
    }
    if (inserted.error) {
      if (inserted.error.code === "23505") {
        const winner = await db.from("dialpad_voice_intents").select("id,property_id,status").eq("org_id", orgId).eq("actor_user_id", actorId).eq("client_idempotency_key", input.idempotencyKey).maybeSingle();
        if (winner.data) return winner.data.property_id === input.propertyId ? { ok: true, intentId: winner.data.id, status: winner.data.status } : { ok: false, error: "idempotency_conflict" };
        return { ok: false, error: "active_call_conflict" };
      }
      try { await release(); } catch { /* reconcile unknown insert result */ }
      return { ok: false, error: "intent_create_failed" };
    }
    let dispatchAttempted = false;
    try {
      const pause = await db.rpc("fn_prepare_dialpad_sequence_pause", { p_intent_id: intentId });
      if (pause.error || !pause.data || typeof pause.data !== "object" || Array.isArray(pause.data) || typeof pause.data.paused !== "number") throw new Error("pause_unconfirmed");
      const rechecked = await inspectLeadCall(input.propertyId);
      if (!rechecked.ok || rechecked.data.propertyId !== input.propertyId || rechecked.data.phoneE164 !== prepared.data.phoneE164) throw new Error("eligibility_changed");
      dispatchAttempted = true;
      const dispatch = await db.rpc("fn_dispatch_dialpad_intent", { p_intent_id: intentId });
      // A lost RPC response may conceal a committed dispatch claim. Never retry.
      if (dispatch.error || !dispatch.data || typeof dispatch.data !== "object" || Array.isArray(dispatch.data) || dispatch.data.dispatched !== true) return { ok: true, intentId, status: "initiation_unconfirmed" };
      try {
        await provider.initiateSelectedDeviceCall({ userId, deviceId, phoneNumber: prepared.data.phoneE164, outboundCallerId: callerId, customData: intentId });
      } catch (error) {
        if (error instanceof DialpadVoiceError && error.code === "http" && [400,401,403,404,422].includes(error.status ?? 0)) {
          const released = await release(error.status);
          return { ok: true, intentId, status: released ? "failed" : "initiation_unconfirmed" };
        }
      }
      return { ok: true, intentId, status: "initiation_unconfirmed" };
    } catch {
      if (!dispatchAttempted) {
        try { if (await release()) return { ok: true, intentId, status: "failed" }; } catch { /* durable reservation requires reconciliation */ }
      }
      return { ok: true, intentId, status: dispatchAttempted ? "initiation_unconfirmed" : "prepared" };
    }
  } catch {
    return { ok: false, error: "dialpad_start_failed" };
  }
}
