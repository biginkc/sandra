/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-side leg reconciliation for the probe gate. Legs created by the browser (escape probes on
// the test connection/app) are not in the inventory, and the guarded client refuses uninventoried
// IDs. A discovered leg is inventoried ONLY after its connection/app ID is proven to be an
// inventoried test resource; anything unprovable is refused and never touched.
import type { Inventory } from "./inventory";
import type { TelnyxClient } from "./telnyx-client";
import type { EventLog } from "./event-log";
import { confirmLegEnded, isAlreadyEnded } from "./leg-confirm";

const MAX_LISTING_PAGES = 100;

/**
 * Lists EVERY active call for a connection/app using cursor pagination (page[limit] <= 250,
 * page[after]). If the listing cannot be exhausted (repeated cursor or page cap) it throws:
 * an incomplete listing must never be read as "empty".
 */
export async function listActiveCalls(client: Pick<TelnyxClient, "request">, scope: string): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    const q = `page[limit]=250${after ? `&page[after]=${encodeURIComponent(after)}` : ""}`;
    const r: any = await client.request("GET", `/connections/${scope}/active_calls?${q}`);
    out.push(...((r?.data as any[]) ?? []));
    const next: string | undefined = r?.meta?.cursors?.after ?? undefined;
    if (!next) return out;
    if (seen.has(next)) throw new Error(`active_calls listing for ${scope} returned a repeating cursor; listing incomplete`);
    seen.add(next);
    after = next;
  }
  throw new Error(`active_calls listing for ${scope} exceeded ${MAX_LISTING_PAGES} pages; listing incomplete`);
}

export function makeLegReconciler(client: Pick<TelnyxClient, "request">, inv: Inventory, log?: Pick<EventLog, "hasHangup">) {
  const endedByHangup = new Set<string>(); // hangup 422 + code 90018
  const owners = new Map<string, string | undefined>(); // ccid -> connection/app id seen in the listing
  const scopes = () => [inv.getRole("connectionId"), inv.getRole("appId")].filter((x): x is string => !!x);

  async function listAliveLegs(): Promise<string[]> {
    const ids: string[] = [];
    for (const scope of scopes()) {
      for (const c of await listActiveCalls(client, scope)) {
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
    try {
      await client.request("POST", `/calls/${id}/actions/hangup`, {});
    } catch (e) {
      if (isAlreadyEnded(e)) { endedByHangup.add(id); return; }
      throw e;
    }
  }

  const confirmEnded = (id: string) => confirmLegEnded(client, log, id, endedByHangup);

  return { listAliveLegs, hangupLeg, confirmLegEnded: confirmEnded };
}
