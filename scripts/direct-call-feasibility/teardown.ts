/* eslint-disable @typescript-eslint/no-explicit-any */
// Teardown per the plan's Failure cleanup order. API key is never touched.
import type { Config } from "./env";
import type { EventLog } from "./event-log";
import type { Inventory } from "./inventory";
import type { Budget } from "./budget";
import type { TelnyxClient } from "./telnyx-client";
import { listActiveCalls } from "./leg-reconcile";
import { confirmLegEnded, isAlreadyEnded } from "./leg-confirm";
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
  skippedRecordings: string[];
  remainingNotInSnapshot: string[];
}

export class TeardownError extends Error {}

export async function runTeardown(d: TeardownDeps): Promise<TeardownReport> {
  const { client, inv, log } = d;
  const say = d.say ?? ((s) => console.log(s));
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const report: TeardownReport = { hungUp: [], skippedForeignLegs: [], deleted: [], skippedRecordings: [], remainingNotInSnapshot: [] };

  // 1. Stop new attempts.
  d.budget?.stop();
  say("1. new attempts stopped");

  // 2. List every active leg on the test connection and test application.
  const scopes = [inv.getRole("connectionId"), inv.getRole("appId")].filter((x): x is string => !!x);
  const found: { ccid: string; scope: string }[] = [];
  for (const scope of scopes) {
    for (const c of await listActiveCalls(client, scope)) found.push({ ccid: c.call_control_id, scope });
  }
  // Legs already inventoried (dialed by us) are also candidates.
  for (const id of inv.idsOf("call_leg")) if (!found.some((f) => f.ccid === id)) found.push({ ccid: id, scope: "" });

  // 3. Re-check each leg's connection/app ID equals an inventoried ID, then hang up.
  const toConfirm: string[] = [];
  const endedByHangup = new Set<string>(); // hangup 422 + code 90018
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
      // Only 422 + code 90018 is confirmation; every other error keeps the obligation.
      if (isAlreadyEnded(e)) { endedByHangup.add(f.ccid); report.hungUp.push(f.ccid); continue; }
      say(`   hangup for ${f.ccid} returned an error; will confirm state: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 4. Confirm terminal ONLY by hangup webhook, hangup 422/90018, or GET is_alive:false (see leg-confirm.ts).
  // Anything else (404, other errors, 2xx hangup) keeps the obligation: retry with backoff for a bounded
  // time, then stop with teardown.incomplete and leave every resource in place for a later teardown run.
  const attempts = d.confirmAttempts ?? 10;
  const unconfirmed: string[] = [];
  for (const ccid of toConfirm) {
    let ended = false;
    for (let i = 0; i < attempts && !ended; i++) {
      ended = await confirmLegEnded(client, log, ccid, endedByHangup);
      if (ended) break;
      if (i > 0) {
        // still not confirmed: re-send hangup (a prior one may have been only acknowledged)
        try { await client.request("POST", `/calls/${ccid}/actions/hangup`, {}); } catch (e) { if (isAlreadyEnded(e)) { ended = true; break; } }
      }
      await sleep(Math.min(1000 * 2 ** i, 30000));
    }
    if (!ended) unconfirmed.push(ccid);
  }
  if (unconfirmed.length) {
    log.append({ source: "harness", type: "teardown.incomplete", data: { unconfirmedLegs: unconfirmed } });
    say(`   teardown.incomplete: ${unconfirmed.join(", ")} not confirmed ended; resources left in place; re-run teardown later`);
    throw new TeardownError(`leg(s) ${unconfirmed.join(", ")} not confirmed ended; resources NOT deleted`);
  }
  say("2-4. active legs listed, owner re-checked, hung up, confirmed terminal");

  // 5. Delete credentials, connection, app, profiles, recordings (plan order).
  // A recording is deleted ONLY if independently proven to belong to an inventoried test call:
  // its call_control_id / call_leg_id / call_session_id must match one recorded when we dialed.
  // A connection-filter listing alone is never enough. Ambiguous ones are skipped and logged.
  const proves = (rec: any): boolean =>
    !!rec && (inv.hasCallRef(rec.call_control_id) || inv.hasCallRef(rec.call_leg_id) || inv.hasCallRef(rec.call_session_id) || inv.has(String(rec.call_control_id ?? ""), ["call_leg"]));
  const candidates = new Map<string, any>();
  for (const scope of scopes) {
    for (const rec of await client.listAll<any>(`/recordings?filter[connection_id]=${scope}`)) if (rec?.id) candidates.set(rec.id, rec);
  }
  for (const id of inv.idsOf("recording")) {
    if (candidates.has(id)) continue;
    try { candidates.set(id, (await client.request("GET", `/recordings/${id}`)).data); } catch { candidates.set(id, undefined); }
  }
  const provenRecordings = new Set<string>();
  for (const [id, rec] of candidates) {
    if (proves(rec)) {
      provenRecordings.add(id);
      if (!inv.has(id)) inv.add("recording", id);
    } else {
      report.skippedRecordings.push(id);
      log.append({ source: "harness", type: "teardown.recording.skipped", data: { id, why: "not provably tied to an inventoried test call" } });
      say(`   skipping recording ${id}: ownership not proven by call identifiers`);
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
      if (type === "recording" && !provenRecordings.has(id)) continue;
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
