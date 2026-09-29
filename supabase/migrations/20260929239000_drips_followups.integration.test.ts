import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { dripBucket, dripStatus, DRIP_BUCKET_LABELS, type DripBucket } from "@/lib/sequences/drip-status";

const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const sql = readFileSync(new URL("./20260929239000_drips_followups.sql", import.meta.url), "utf8");
const reasons: readonly [string, DripBucket | null][] = [
  ["inbound_reply", "replied"], ["rep_sms_human_takeover", "replied"],
  ["provider_failed", "couldnt_send"], ["reconciliation_required", "couldnt_send"],
  ["template_missing", "couldnt_send"], ["step_misconfigured", "couldnt_send"],
  ["no_phone", "couldnt_send"], ["no_approved_sender", "couldnt_send"],
  ["no approved sender for first-touch sequence send", "couldnt_send"],
  ["manual", null],
];
type Snapshot = { rows: Array<{ thread_id: string; in_drip: boolean; drip_replied: boolean }>; counts: Record<string, number>; total: number };

it("keeps SQL and TypeScript pause buckets in one table and enforces triage and inbox reply guards", async () => {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    const org = randomUUID(), actor = randomUUID(), sequence = randomUUID(), step = randomUUID();
    const marker = `pr8${randomUUID().replaceAll("-", "")}`;
    await db.query("insert into auth.users(id) values ($1)", [actor]);
    await db.query("insert into public.organizations(id,name) values ($1,$2)", [org, marker]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [actor, org]);
    await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'PR8 drip')", [sequence, org]);
    await db.query("insert into public.sequence_steps(id,sequence_id,step_index,action_type,template_body) values ($1,$2,0,'send_sms','Hi')", [step, sequence]);
    const ids = new Map<string, { property: string; thread: string; enrollment: string }>();
    const kinds = [...reasons.map(([reason]) => reason), "active", "completed", "dispo", "needs_valid", "needs_no_inbound", "needs_dnc"];
    for (const kind of kinds) {
      const property = randomUUID(), thread = randomUUID(), contact = randomUUID();
      await db.query("insert into public.contacts(id,org_id,first_name,do_not_contact) values ($1,$2,$3,$4)", [contact,org,marker,kind === "needs_dnc"]);
      await db.query("insert into public.properties(id,org_id,address,state,status,homeowner_contact_id,outreach_dispo,is_dnc_locked) values ($1,$2,$3,'MO','new_lead',$4,$5,$6)",
        [property,org,kind,contact,kind.startsWith("needs_") ? "needs_sequence" : null,kind === "needs_dnc"]);
      let enrollment = "";
      if (!kind.startsWith("needs_")) {
        enrollment = (await db.query<{ id: string }>("insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,pause_reason) values ($1,$2,$3,$4,$5,$6) returning id",
          [org,sequence,property,contact,kind === "active" ? "active" : kind === "completed" ? "completed" : "paused", kind === "dispo" ? "inbound_reply" : reasons.some(([r]) => r === kind) ? kind : null])).rows[0]!.id;
      }
      ids.set(kind,{property,thread,enrollment});
      if (kind !== "needs_no_inbound") await db.query("insert into public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,body,from_address,to_address,created_at) values ($1,$2,$3,$4,'sms','inbound','received',$5,'+18165550100','+18165550200','2026-09-03T00:00:00Z')",
        [org,contact,property,thread,marker]);
    }
    // Attribute replies to a real drip step. Active enrollments remain in the
    // filter but never carry an outstanding replied flag after a resume.
    for (const kind of ["inbound_reply", "rep_sms_human_takeover", "completed", "active", "dispo"]) {
      const item = ids.get(kind)!;
      const contact = (await db.query<{homeowner_contact_id:string}>(
        "select homeowner_contact_id from public.properties where id=$1",[item.property])).rows[0]!.homeowner_contact_id;
      const sent = (await db.query<{id:string}>(
        "insert into public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,body,from_address,to_address,created_at,sent_at) values ($1,$2,$3,$4,'sms','outbound','sent','Drip text','+18165550200','+18165550100','2026-09-02T00:00:00Z','2026-09-02T00:00:00Z') returning id",
        [org,contact,item.property,item.thread])).rows[0]!.id;
      await db.query("insert into public.sequence_step_runs(enrollment_id,step_id,message_id,scheduled_for,run_at) values ($1,$2,$3,'2026-09-02T00:00:00Z','2026-09-02T00:00:00Z')",[item.enrollment,step,sent]);
      if (kind === "completed") await db.query(
        "update public.sequence_step_runs set run_at='2026-09-04T00:00:00Z' where message_id=$1",[sent]);
    }
    const asActor = async () => {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
    };
    const stats = async () => {
      await asActor();
      const overview = (await db.query("select * from public.sequence_overview_stats($1)",[org])).rows[0];
      const needs = (await db.query("select property_id,bucket from public.sequence_needs_person($1)",[org])).rows;
      const counts = (await db.query("select * from public.sequence_needs_person_counts($1)",[org])).rows[0];
      const page = (await db.query("select property_id from public.sequence_needs_person_page($1,'needs_sequence',0,100)",[org])).rows;
      await db.query("reset role");
      return {overview,needs,counts,page};
    };
    if (process.env.PR8_TEST_BASELINE !== "1") await db.query(
      process.env.PR8_DROP_SQL_REASON === "1"
        ? sql.replaceAll("'no_phone','no_approved_sender'", "'no_approved_sender'")
        : sql);
    const result = await stats();
    const byProperty = new Map(result.needs.map(row => [row.property_id,row.bucket]));
    for (const [reason, expected] of reasons) {
      expect(dripBucket({status:"paused",pause_reason:reason})).toBe(expected);
      expect(dripStatus("paused",reason,false)).toBe(expected ? DRIP_BUCKET_LABELS[expected] : null);
      expect(byProperty.get(ids.get(reason)!.property)).toBe(expected === "couldnt_send" ? "couldnt_send" : undefined);
    }
    expect(Number(result.overview.couldnt_send)).toBe(7);
    // The completed drip replied after sent_at but before run_at; sent_at wins.
    expect(Number(result.overview.finished_no_reply)).toBe(0);
    expect(byProperty.has(ids.get("completed")!.property)).toBe(false);
    await asActor();
    const stepStats = (await db.query("select * from public.sequence_step_stats($1,$2)",[org,sequence])).rows[0];
    await db.query("reset role");
    expect(Number(stepStats.replied)).toBe(5);
    expect(Number(result.counts.couldnt_send)).toBe(7);
    expect(byProperty.get(ids.get("needs_valid")!.property)).toBe("needs_sequence");
    expect(byProperty.has(ids.get("needs_no_inbound")!.property)).toBe(false);
    expect(byProperty.has(ids.get("needs_dnc")!.property)).toBe(false);
    expect(result.page.map(row=>row.property_id)).toEqual([ids.get("needs_valid")!.property]);

    const snapshot = async (filter:string): Promise<Snapshot> => {
      await asActor();
      const result = (await db.query<{snapshot:Snapshot}>(
        "select public.sms_inbox_thread_page_snapshot(now()-interval '90 days',$1,null,null,false,500,0,$2) as snapshot",[filter,marker])).rows[0]!.snapshot;
      await db.query("reset role");
      return result;
    };
    const beforeAction = await snapshot("all");
    expect(beforeAction.counts.in_drip).toBe(reasons.length + 2);
    expect((await snapshot("in_drip")).total).toBe(reasons.length + 2);
    const byThread = new Map(beforeAction.rows.map(row=>[row.thread_id,row]));
    for (const kind of ["inbound_reply","rep_sms_human_takeover","completed","dispo"])
      expect(byThread.get(ids.get(kind)!.thread)?.drip_replied).toBe(true);
    expect(byThread.get(ids.get("active")!.thread)?.drip_replied).toBe(false);
    expect((await snapshot("drip_replied")).total).toBe(4);
    const replied = ids.get("inbound_reply")!;
    await db.query("insert into public.messages(org_id,property_id,channel,direction,status,body,created_at) values ($1,$2,'sms','outbound','sent','Human action','2026-09-04T00:00:00Z')",[org,replied.property]);
    const completed = ids.get("completed")!;
    await db.query("insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,recorded_at,idempotency_key) values ($1,$2,$3,'outreach','manual','reached','2026-09-01T00:00:00Z','2026-09-04T00:00:00Z',$4)",[org,completed.property,actor,randomUUID()]);
    expect((await snapshot("drip_replied")).total).toBe(2);
    const takeover = ids.get("rep_sms_human_takeover")!;
    await db.query("insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,created_at) values ($1,$2,'user',$3,'my_leads_workflow','{\"operation\":\"ready_acquisition_offer\"}','2026-09-04T00:00:00Z')",[org,takeover.property,actor]);
    expect((await snapshot("drip_replied")).total).toBe(1);
    const dispo = ids.get("dispo")!;
    await db.query("insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,created_at) values ($1,$2,'user',$3,'dispo_set','2026-09-04T00:00:00Z')",[org,dispo.property,actor]);
    expect((await snapshot("drip_replied")).total).toBe(0);
    const afterAction = await snapshot("all");
    expect(afterAction.rows.find(row=>row.thread_id===replied.thread)?.drip_replied).toBe(false);
    expect(afterAction.rows.find(row=>row.thread_id===completed.thread)?.drip_replied).toBe(false);
    // A caller with the authenticated SQL role but no JWT role claim must
    // never enter the service-role tenant bypass in the definer snapshot.
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.role','',true)");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
    const withoutJwtRole = (await db.query<{snapshot:Snapshot}>(
      "select public.sms_inbox_thread_page_snapshot(now()-interval '90 days','all',null,null,false,500,0,$1) as snapshot",[marker])).rows[0]!.snapshot;
    expect(withoutJwtRole.total).toBe(0);
    await db.query("reset role");
  } finally {
    await db.query("rollback").catch(()=>{});
    await db.end();
  }
}, 60_000);
