/* eslint-disable @typescript-eslint/no-explicit-any */
// Teardown per the plan's Failure cleanup order. API key is never touched.
import type { Config } from "./env";
import type { EventLog } from "./event-log";
import type { Inventory } from "./inventory";
import type { Budget } from "./budget";
import type { TelnyxClient } from "./telnyx-client";
import { SNAPSHOT_FILE, type Snapshot } from "./preflight";

export interface TeardownDeps {
  client: TelnyxClient;
  inv: Inventory;
  cfg: Config;
  log: EventLog;
  budget?: Budget;
  say?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** polls for terminal confirmation per leg */
  confirmAttempts?: number;
}

export interface TeardownReport {
  hungUp: string[];
  skippedForeignLegs: string[];
  deleted: string[];
  remainingNotInSnapshot: string[];
}

export class TeardownError extends Error {}

export async function runTeardown(d: TeardownDeps): Promise<TeardownReport> {
  const { client, inv, log } = d;
  const say = d.say ?? ((s) => console.log(s));
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const report: TeardownReport = { hungUp: [], skippedForeignLegs: [], deleted: [], remainingNotInSnapshot: [] };

  // 1. Stop new attempts.
  d.budget?.stop();
  say("1. new attempts stopped");

  // 2. List every active leg on the test connection and test application.
  const scopes = [inv.getRole("connectionId"), inv.getRole("appId")].filter((x): x is string => !!x);
  const found: { ccid: string; scope: string }[] = [];
  for (const scope of scopes) {
    const r = await client.request("GET", `/connections/${scope}/active_calls?page[size]=250`);
    for (const c of (r.data as any[]) ?? []) found.push({ ccid: c.call_control_id, scope });
  }
  // Legs already inventoried (dialed by us) are also candidates.
  for (const id of inv.idsOf("call_leg")) if (!found.some((f) => f.ccid === id)) found.push({ ccid: id, scope: "" });

  // 3. Re-check each leg's connection/app ID equals an inventoried ID, then hang up.
  const toConfirm: string[] = [];
  for (const f of found) {
    let ownerOk = f.scope !== "" && inv.has(f.scope);
    if (!inv.has(f.ccid, ["call_leg"])) {
      const detail = (await client.request("GET", `/calls/${f.ccid}`)).data ?? {};
      const reported: string | undefined = detail.connection_id ?? detail.application_id;
      if (reported !== undefined) ownerOk = inv.has(reported, ["credential_connection", "call_control_application"]);
      if (!ownerOk) {
        report.skippedForeignLegs.push(f.ccid);
        say(`   refusing to control leg ${f.ccid}: owner does not match inventory`);
        continue;
      }
      inv.add("call_leg", f.ccid);
    }
    toConfirm.push(f.ccid);
    try {
      await client.request("POST", `/calls/${f.ccid}/actions/hangup`, {});
      report.hungUp.push(f.ccid);
    } catch (e) {
      // 404/422 usually means already ended; confirmation below decides.
      say(`   hangup for ${f.ccid} returned an error; will confirm state: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 4. Confirm terminal by provider evidence (hangup webhook or is_alive false).
  const attempts = d.confirmAttempts ?? 10;
  for (const ccid of toConfirm) {
    let ended = false;
    for (let i = 0; i < attempts && !ended; i++) {
      if (log.hasHangup(ccid)) { ended = true; break; }
      try {
        const st = (await client.request("GET", `/calls/${ccid}`)).data;
        if (st?.is_alive === false) ended = true;
      } catch (e: any) {
        if (e?.status === 404) ended = true;
      }
      if (!ended) await sleep(1000);
    }
    if (!ended) throw new TeardownError(`leg ${ccid} not confirmed ended; resources NOT deleted`);
  }
  say("2-4. active legs listed, owner re-checked, hung up, confirmed terminal");

  // 5. Delete credentials, connection, app, profiles, recordings (plan order).
  for (const scope of scopes) {
    for (const rec of await client.listAll<any>(`/recordings?filter[connection_id]=${scope}`)) {
      if (rec.id && !inv.has(rec.id)) inv.add("recording", rec.id);
    }
  }
  const order: [string, import("./inventory").ResourceType][] = [
    ["telephony_credentials", "telephony_credential"],
    ["credential_connections", "credential_connection"],
    ["call_control_applications", "call_control_application"],
    ["outbound_voice_profiles", "outbound_voice_profile"],
    ["recordings", "recording"],
  ];
  for (const [collection, type] of order) {
    for (const id of inv.idsOf(type)) {
      await client.request("DELETE", `/${collection}/${id}`);
      inv.markDeleted(id);
      report.deleted.push(id);
    }
  }

  // 6. List what remains and diff against the preflight snapshot.
  const snap = inv.loadSnapshot<Snapshot>(SNAPSHOT_FILE);
  const now: [keyof Snapshot, string][] = [
    ["credential_connections", "/credential_connections"],
    ["call_control_applications", "/call_control_applications"],
    ["outbound_voice_profiles", "/outbound_voice_profiles"],
    ["telephony_credentials", "/telephony_credentials"],
    ["phone_numbers", "/phone_numbers"],
  ];
  for (const [key, p] of now) {
    const known = new Set((snap?.[key] as string[] | undefined) ?? []);
    for (const x of await client.listAll<{ id: string }>(p)) if (!known.has(x.id)) report.remainingNotInSnapshot.push(`${key}:${x.id}`);
  }
  say(report.remainingNotInSnapshot.length ? `6. NOT clean: ${report.remainingNotInSnapshot.join(", ")}` : "6. remaining resources match preflight snapshot");
  return report;
}
