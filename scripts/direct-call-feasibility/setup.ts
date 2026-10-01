 
// Creates the plan's isolated test resources and reads back the safety settings.
import { randomBytes } from "node:crypto";
import type { Config } from "./env";
import type { Inventory } from "./inventory";
import type { TelnyxClient } from "./telnyx-client";

export class SetupError extends Error {}

export async function runSetup(client: TelnyxClient, inv: Inventory, cfg: Config): Promise<void> {
  const tag = `dcf-test-${Date.now()}`;
  const { limits } = cfg;

  // Two profiles: disabled (on the browser connection), enabled + capped (on the Voice API app).
  const disabled = await client.request("POST", "/outbound_voice_profiles", {
    name: `${tag}-disabled`, enabled: false, traffic_type: "conversational", service_plan: "global",
  });
  const disabledId: string = disabled.data.id;
  inv.add("outbound_voice_profile", disabledId);
  inv.setRole("disabledProfileId", disabledId);

  const capped = await client.request("POST", "/outbound_voice_profiles", {
    name: `${tag}-capped`, enabled: true, traffic_type: "conversational", service_plan: "global",
    daily_spend_limit: String(limits.profileDailyCapUsd), daily_spend_limit_enabled: true,
    concurrent_call_limit: limits.profileConcurrentLimit,
  });
  const cappedId: string = capped.data.id;
  inv.add("outbound_voice_profile", cappedId);
  inv.setRole("cappedProfileId", cappedId);

  // Credential connection: internal-only SIP URI calling, disabled profile attached.
  const conn = await client.request("POST", "/credential_connections", {
    connection_name: `${tag}-connection`,
    user_name: `dcf${randomBytes(6).toString("hex")}`,
    password: randomBytes(18).toString("base64url"),
    sip_uri_calling_preference: "internal",
    active: true,
    outbound: { outbound_voice_profile_id: disabledId },
  });
  const connId: string = conn.data.id;
  inv.add("credential_connection", connId);
  inv.setRole("connectionId", connId);

  // Voice API (call control) app: webhooks to the tunnel, capped profile attached.
  const app = await client.request("POST", "/call_control_applications", {
    application_name: `${tag}-app`,
    webhook_event_url: `${cfg.publicBaseUrl}/webhook`,
    webhook_api_version: "2",
    active: true,
    outbound: { outbound_voice_profile_id: cappedId },
  });
  const appId: string = app.data.id;
  inv.add("call_control_application", appId);
  inv.setRole("appId", appId);

  // Two test credentials on the connection: the browser, and a second as an on-account SIP escape target.
  for (const role of ["browser", "escape"] as const) {
    const cred = await client.request("POST", "/telephony_credentials", { connection_id: connId, name: `${tag}-${role}` });
    inv.add("telephony_credential", cred.data.id);
    inv.setRole(`${role}CredentialId`, cred.data.id);
    if (cred.data.sip_username) {
      inv.addSipUsername(cred.data.sip_username);
      inv.setRole(`${role}SipUsername`, cred.data.sip_username);
    }
  }

  await verifyReadBack(client, inv, cfg);
}

/** Refuses to proceed unless cap, limit, enabled flags and attachments read back as set. */
export async function verifyReadBack(client: TelnyxClient, inv: Inventory, cfg: Config): Promise<void> {
  const need = (k: string) => {
    const v = inv.getRole(k);
    if (!v) throw new SetupError(`missing inventory role ${k}`);
    return v;
  };
  const dis = (await client.request("GET", `/outbound_voice_profiles/${need("disabledProfileId")}`)).data;
  const cap = (await client.request("GET", `/outbound_voice_profiles/${need("cappedProfileId")}`)).data;
  const conn = (await client.request("GET", `/credential_connections/${need("connectionId")}`)).data;
  const app = (await client.request("GET", `/call_control_applications/${need("appId")}`)).data;
  const problems: string[] = [];
  if (dis.enabled !== false) problems.push("disabled profile is not disabled");
  if (cap.enabled !== true) problems.push("capped profile is not enabled");
  if (Number(cap.daily_spend_limit) !== cfg.limits.profileDailyCapUsd || cap.daily_spend_limit_enabled !== true) problems.push("daily spend cap did not read back as set");
  if (Number(cap.concurrent_call_limit) !== cfg.limits.profileConcurrentLimit) problems.push("concurrent call limit did not read back as set");
  if (conn.outbound?.outbound_voice_profile_id !== need("disabledProfileId")) problems.push("connection is not on the disabled profile");
  if (conn.sip_uri_calling_preference !== "internal") problems.push("connection sip_uri_calling_preference is not internal");
  if (app.outbound?.outbound_voice_profile_id !== need("cappedProfileId")) problems.push("app is not on the capped profile");
  if (problems.length) throw new SetupError(`read-back mismatch, nothing will be dialed: ${problems.join("; ")}`);
}
