 
// Read-only preflight: snapshot existing account resources and confirm the caller ID is on this account.
import type { Config } from "./env";
import { maskPhone } from "./env";
import type { Inventory } from "./inventory";
import type { TelnyxClient } from "./telnyx-client";

export interface Snapshot {
  takenAt: string;
  phone_numbers: string[];
  credential_connections: string[];
  call_control_applications: string[];
  outbound_voice_profiles: string[];
  telephony_credentials: string[];
  callerIdOnAccount: boolean;
}

export const SNAPSHOT_FILE = "preflight.json";

export async function runPreflight(client: TelnyxClient, inv: Inventory, cfg: Config): Promise<Snapshot> {
  const ids = async (p: string) => (await client.listAll<{ id: string }>(p)).map((x) => x.id);
  const numbers = await client.listAll<{ id: string; phone_number: string }>("/phone_numbers");
  const snap: Snapshot = {
    takenAt: new Date().toISOString(),
    phone_numbers: numbers.map((n) => n.id),
    credential_connections: await ids("/credential_connections"),
    call_control_applications: await ids("/call_control_applications"),
    outbound_voice_profiles: await ids("/outbound_voice_profiles"),
    telephony_credentials: await ids("/telephony_credentials"),
    callerIdOnAccount: numbers.some((n) => n.phone_number === cfg.callerId),
  };
  if (!snap.callerIdOnAccount) {
    throw new Error(`Caller ID ${maskPhone(cfg.callerId)} is not on this Telnyx account. Stop and ask Jarrad; do not proceed or reassign anything.`);
  }
  inv.saveSnapshot(SNAPSHOT_FILE, snap);
  return snap;
}
