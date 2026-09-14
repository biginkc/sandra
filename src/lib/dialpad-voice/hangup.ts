"use server";

import { getAcquisitionRoster } from "@/lib/my-leads/queries";
import { createDialpadVoiceAdminClient } from "./database";
import { DialpadVoiceClient } from "./client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ends only a provider-bound call owned by the authenticated pilot rep.
 * A successful API request is not terminal evidence and releases no ownership.
 */
export async function hangupMariaDialpadCall(input: { intentId: string }) {
  if (process.env.DIALPAD_VOICE_HANGUP_ENABLED !== "true") return { ok: false, error: "dialpad_hangup_disabled" } as const;
  const orgId = process.env.DIALPAD_VOICE_ORG_ID;
  const actorId = process.env.DIALPAD_VOICE_SANDRA_USER_ID;
  const apiKey = process.env.DIALPAD_VOICE_API_KEY;
  if (!orgId || !actorId || !UUID.test(orgId) || !UUID.test(actorId) || !apiKey ||
    process.env.DIALPAD_VOICE_USER_ID !== "4904023124647936") return { ok: false, error: "dialpad_hangup_unconfigured" } as const;
  if (!input || typeof input.intentId !== "string" || !UUID.test(input.intentId)) return { ok: false, error: "invalid_input" } as const;
  try {
    const { viewer, roster } = await getAcquisitionRoster();
    // Disabling new acquisitions must not prevent the owning active rep from
    // ending an existing call. Membership and exact identity still apply.
    if (viewer.orgId !== orgId || viewer.userId !== actorId || !roster.members.some(member => member.id === actorId && member.active)) {
      return { ok: false, error: "forbidden" } as const;
    }
    const db = createDialpadVoiceAdminClient();
    const intent = await db.from("dialpad_voice_intents").select("provider_call_id,dialpad_user_id,property_id")
      .eq("id", input.intentId).eq("org_id", orgId).eq("actor_user_id", actorId).maybeSingle();
    if (intent.error || !intent.data || intent.data.dialpad_user_id !== "4904023124647936" ||
      !intent.data.provider_call_id || !/^[0-9]+$/.test(intent.data.provider_call_id)) return { ok: false, error: "bound_call_required" } as const;
    const activity = await db.from("call_activities").select("id,provider_ended_at")
      .eq("org_id", orgId).eq("operator_user_id", actorId).eq("property_id", intent.data.property_id)
      .eq("provider", "dialpad").eq("provider_call_id", intent.data.provider_call_id).maybeSingle();
    if (activity.error || !activity.data) return { ok: false, error: "bound_call_required" } as const;
    if (activity.data.provider_ended_at) return { ok: true, status: "already_ended" } as const;
    try {
      await new DialpadVoiceClient(apiKey).hangupCall(intent.data.provider_call_id);
      return { ok: true, status: "hangup_requested" } as const;
    } catch {
      // No automatic retry and no claim that the remote party disconnected.
      return { ok: true, status: "hangup_unconfirmed" } as const;
    }
  } catch {
    return { ok: false, error: "dialpad_hangup_failed" } as const;
  }
}
