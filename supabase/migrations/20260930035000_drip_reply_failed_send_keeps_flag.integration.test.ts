import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const migration = readFileSync(new URL("./20260930035000_drip_reply_failed_send_keeps_flag.sql", import.meta.url), "utf8");

it("keeps failed and uncertain rep replies outstanding in both SQL read models until a send succeeds", async () => {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await db.query(migration.replace(/^begin;\s*/i, "").replace(/\s*commit;\s*$/i, ""));
    const org = randomUUID(), rep = randomUUID(), sequence = randomUUID(), step = randomUUID();
    const marker = `failedreply${randomUUID().replaceAll("-", "")}`;
    await db.query("insert into auth.users(id) values ($1)", [rep]);
    await db.query("insert into public.organizations(id,name) values ($1,$2)", [org, marker]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [rep, org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [rep]);
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${rep}:${org}:${rep}`]);
    await db.query("update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2", [rep, org]);
    await db.query("select set_config('my_leads.designation_update','',true)");
    await db.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)", [org]);
    await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Failed send drip')", [sequence, org]);
    await db.query("insert into public.sequence_steps(id,sequence_id,step_index,action_type,template_body) values ($1,$2,0,'send_sms','Follow up')", [step, sequence]);

    const cases = [
      { name: "failed", status: "failed", metadata: {} },
      { name: "uncertain", status: "failed", metadata: { providerOutcome: "provider_unknown" } },
      { name: "sent", status: "sent", metadata: {} },
      { name: "delivered", status: "delivered", metadata: {} },
      { name: "pending", status: "pending", metadata: {} },
      { name: "queued", status: "queued", metadata: {} },
      { name: "failed_then_sent", status: "failed", metadata: {} },
    ];
    const ids = new Map<string, { property: string; thread: string }>();
    for (const item of cases) {
      const property = randomUUID(), thread = randomUUID(), contact = randomUUID();
      ids.set(item.name, { property, thread });
      await db.query("insert into public.contacts(id,org_id,first_name) values ($1,$2,$3)", [contact, org, marker]);
      await db.query("insert into public.properties(id,org_id,address,state,status,homeowner_contact_id,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4,$5)", [property, org, item.name, contact, rep]);
      const enrollment = (await db.query<{ id: string }>("insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,pause_reason) values ($1,$2,$3,$4,'paused','inbound_reply') returning id", [org, sequence, property, contact])).rows[0]!.id;
      const drip = (await db.query<{ id: string }>("insert into public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,body,from_address,to_address,created_at) values ($1,$2,$3,$4,'sms','outbound','sent','Drip text','+18165550200','+18165550100','2026-09-02T00:00:00Z') returning id", [org, contact, property, thread])).rows[0]!.id;
      await db.query("insert into public.sequence_step_runs(enrollment_id,step_id,message_id,scheduled_for,run_at) values ($1,$2,$3,'2026-09-02T00:00:00Z','2026-09-02T00:00:00Z')", [enrollment, step, drip]);
      await db.query("insert into public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,body,from_address,to_address,created_at) values ($1,$2,$3,$4,'sms','inbound','received',$5,'+18165550100','+18165550200','2026-09-03T00:00:00Z')", [org, contact, property, thread, marker]);
      await db.query("insert into public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,metadata,body,from_address,to_address,created_at) values ($1,$2,$3,$4,'sms','outbound',$5,$6,'Rep reply','+18165550200','+18165550100','2026-09-04T00:00:00Z')", [org, contact, property, thread, item.status, item.metadata]);
      if (item.name === "failed_then_sent") await db.query("insert into public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,body,from_address,to_address,created_at) values ($1,$2,$3,$4,'sms','outbound','sent','Later rep reply','+18165550200','+18165550100','2026-09-05T00:00:00Z')", [org, contact, property, thread]);
    }

    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [rep]);
    const snapshot = (await db.query<{ snapshot: { rows: Array<{ thread_id: string; drip_replied: boolean }> } }>("select public.sms_inbox_thread_page_snapshot(now()-interval '90 days','all',null,null,false,500,0,$1) as snapshot", [marker])).rows[0]!.snapshot;
    const scope = (await db.query<{ property_id: string; replied_at: Date | null }>("select property_id,replied_at from public.fn_list_my_leads_drip_scope($1,$2)", [org, rep])).rows;
    const byThread = new Map(snapshot.rows.map(row => [row.thread_id, row.drip_replied]));
    const byProperty = new Map(scope.map(row => [row.property_id, row.replied_at]));
    for (const item of cases) {
      const id = ids.get(item.name)!;
      const outstanding = item.name === "failed" || item.name === "uncertain";
      expect.soft(byThread.get(id.thread), `snapshot ${item.name}`).toBe(outstanding);
      expect.soft(Boolean(byProperty.get(id.property)), `My Leads ${item.name}`).toBe(outstanding);
    }
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}, 60_000);
