import { writeFileSync } from "node:fs";
import path from "node:path";

import { seedFeatureFlags } from "../support/my-leads-close-fixture";
import type { GateController } from "./gates";
import { asService, type Db } from "./db";
import type { StubServer } from "./stubs";
import type { StressConfig } from "./config";
import type { World } from "./world";
import { teardownWorld } from "./world";

/**
 * Kill switch. On ANY invariant miss, watchdog overrun, egress violation or KILL file the harness does,
 * in this order and never reordered:
 *   1. close the stub/provider gates so no new provider request can leave
 *   2. set every `my_leads_feature_flags` flag false for the org
 *   3. reconcile run-owned in-flight calls (stub leg: cancel authorized-but-unmatched intents; a live
 *      leg additionally hangs up through the provider, see live-leg.ts)
 *   4. snapshot evidence
 *   5. only then clean up
 * Flags cannot recall accepted SMS, contracts or calls; the report lists them.
 */

export type KillReport = {
  reason: string;
  at: string;
  steps: Array<{ step: number; name: string; ok: boolean; detail: string }>;
  cannotRecall: { smsAccepted: number; contractsSent: number; callsDialled: number };
};

export const EVIDENCE_TABLES: ReadonlyArray<[string, string]> = [
  ["properties", "select id,address,assigned_user_id,deleted_at from public.properties where org_id=$1 and address like $2 || '%'"],
  ["dialpad_call_intents", "select id,property_id,status,idempotency_key,destination_e164,custom_data,prepared_at,expires_at,dispatch_authorized_at,failed_at,matched_provider_call_id from public.dialpad_call_intents where org_id=$1 and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
  ["dialpad_call_events", "select id,provider_call_id,event_state,event_timestamp_ms,payload_sha256,disposition,disposition_reason,matched_intent_id from public.dialpad_call_events where org_id=$1"],
  ["call_activities", "select id,property_id,provider,provider_call_id,outcome from public.call_activities where org_id=$1 and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
  ["acquisition_attempts", "select id,property_id,source,outcome,call_activity_id,note,occurred_at from public.acquisition_attempts where org_id=$1 and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
  ["lead_notes", "select id,property_id,body from public.lead_notes where org_id=$1 and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
  ["tasks", "select id,related_property_id,type,status,due_at,calendar_chain_id,created_at from public.tasks where org_id=$1 and related_property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
  ["acquisition_offers", "select id,property_id,outcome,amount_cents,sent_at from public.acquisition_offers where org_id=$1 and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
  ["acquisition_offer_projections", "select id,property_id,state,conflict_code,esign_request_id,offer_id,send_intent_id from public.acquisition_offer_projections where org_id=$1 and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
  ["esign_requests", "select id,property_id,delivery_state,sign_request_id,send_intent_id from public.esign_requests where org_id=$1 and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
  ["seller_appointment_reminders", "select id,task_id,calendar_chain_id,status,skip_reason,send_local_date,send_key,message_id from public.seller_appointment_reminders where org_id=$1 and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
  ["messages", "select id,direction,provider,to_address,from_address,status,idempotency_key,sent_at from public.messages where org_id=$1 and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')"],
];

export async function snapshotEvidence(db: Db, cfg: StressConfig, file: string): Promise<void> {
  const dump: Record<string, unknown[]> = {};
  for (const [name, sql] of EVIDENCE_TABLES) {
    dump[name] = (await db.query(sql, sql.includes("$2") ? [cfg.orgId, cfg.runTag] : [cfg.orgId])).rows;
  }
  writeFileSync(file, JSON.stringify(dump, null, 1));
}

export async function killSwitch(args: {
  reason: string;
  cfg: StressConfig;
  db: Db;
  world: World | null;
  stub: StubServer;
  extraGates?: GateController[];
  artifactsDir: string;
  cleanup: boolean;
}): Promise<KillReport> {
  const { cfg, db, world, stub } = args;
  const report: KillReport = { reason: args.reason, at: new Date().toISOString(), steps: [], cannotRecall: { smsAccepted: 0, contractsSent: 0, callsDialled: 0 } };
  const step = async (n: number, name: string, fn: () => Promise<string>) => {
    try {
      report.steps.push({ step: n, name, ok: true, detail: await fn() });
    } catch (e) {
      report.steps.push({ step: n, name, ok: false, detail: (e as Error).message });
    }
  };
  // 1. No new provider request can leave.
  await step(1, "close provider gates", async () => {
    stub.gates.closeAll();
    for (const g of args.extraGates ?? []) g.closeAll();
    return "stub and proxy gates closed; provider routes now answer 503";
  });
  // 2. Every flag false for the org.
  await step(2, "all my_leads flags off", async () => {
    await seedFeatureFlags(db, cfg.orgId, []);
    const r = await db.query<{ on: number }>("select (call_next_strip::int + post_call_prompt::int + click_to_dial::int + native_matcher::int + auto_prompt::int + callback_alert::int + call_screen::int + contract_card::int + seller_reminders::int + artifact_fetch::int + facts_job::int + offer_projection::int + comp_queue::int) as on from public.my_leads_feature_flags where org_id=$1", [cfg.orgId]);
    if ((r.rows[0]?.on ?? 0) !== 0) throw new Error("a flag is still on");
    return "13/13 flags false";
  });
  // 3. Reconcile run-owned in-flight calls.
  await step(3, "reconcile in-flight calls", async () => {
    if (!world) return "no world";
    const open = await db.query<{ id: string }>("select id from public.dialpad_call_intents where org_id=$1 and status='prepared' and expires_at > now() and property_id in (select id from public.properties where org_id=$1 and address like $2 || '%')", [cfg.orgId, cfg.runTag]);
    let cancelled = 0;
    for (const row of open.rows) {
      await asService(db, (c) => c.query("select public.fn_cancel_dialpad_call_intent($1,$2,$3)", [cfg.orgId, world.repUserId, row.id])).then(() => (cancelled += 1)).catch(() => {});
    }
    return `${open.rows.length} open intent(s), ${cancelled} cancelled (provider-side hangup is live-leg only)`;
  });
  // 4. Evidence.
  await step(4, "snapshot evidence", async () => {
    await snapshotEvidence(db, cfg, path.join(args.artifactsDir, "test-org-dump.json"));
    return "test-org-dump.json written";
  });
  // 5. Cleanup, only after everything above.
  await step(5, "cleanup", async () => {
    if (!args.cleanup || !world) return "skipped (cleanup disabled)";
    await teardownWorld(db, world);
    return "flags row removed, Dialpad connection disabled, binding revoked, reminder settings removed (leads retained as evidence)";
  });
  report.cannotRecall = {
    smsAccepted: (await db.query<{ n: number }>("select count(*)::int n from public.messages where org_id=$1 and direction='outbound'", [cfg.orgId]).catch(() => ({ rows: [{ n: -1 }] }))).rows[0]!.n,
    contractsSent: stub.sends().length,
    callsDialled: stub.dials().length,
  };
  writeFileSync(path.join(args.artifactsDir, "kill-switch.json"), JSON.stringify(report, null, 2));
  return report;
}
