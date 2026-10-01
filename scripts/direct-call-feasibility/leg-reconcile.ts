/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-side leg reconciliation for the probe gate. Legs created by the browser (escape probes on
// the test connection/app) are not in the inventory, and the guarded client refuses uninventoried
// IDs. A discovered leg is inventoried ONLY after its connection/app ID is proven to be an
// inventoried test resource; anything unprovable is refused and never touched.
import type { Inventory } from "./inventory";
import type { TelnyxClient } from "./telnyx-client";

export function makeLegReconciler(client: Pick<TelnyxClient, "request">, inv: Inventory) {
  const owners = new Map<string, string | undefined>(); // ccid -> connection/app id seen in the listing
  const scopes = () => [inv.getRole("connectionId"), inv.getRole("appId")].filter((x): x is string => !!x);

  async function listAliveLegs(): Promise<string[]> {
    const ids: string[] = [];
    for (const scope of scopes()) {
      const r = await client.request("GET", `/connections/${scope}/active_calls?page[size]=250`);
      for (const c of (r.data as any[]) ?? []) {
        if (!c.call_control_id) continue;
        ids.push(c.call_control_id);
        owners.set(c.call_control_id, c.connection_id ?? c.application_id);
      }
    }
    return ids;
  }

  async function hangupLeg(id: string): Promise<void> {
    if (!inv.has(id, ["call_leg"])) {
      let owner = owners.get(id);
      if (owner === undefined) {
        const detail = ((await client.request("GET", `/calls/${id}`)).data ?? {}) as any;
        owner = detail.connection_id ?? detail.application_id;
      }
      if (owner === undefined || !inv.has(owner, ["credential_connection", "call_control_application"])) {
        throw new Error(`refusing to control leg ${id}: owner cannot be proven to be a test resource`);
      }
      inv.add("call_leg", id);
    }
    await client.request("POST", `/calls/${id}/actions/hangup`, {});
  }

  return { listAliveLegs, hangupLeg };
}
