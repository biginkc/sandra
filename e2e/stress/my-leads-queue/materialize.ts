import { randomUUID } from "node:crypto";

import type { Client } from "pg";

import type { Lead, LedgerState, Msg, World } from "./model";
import { HOUR } from "./model";

/**
 * The single translation layer from the abstract fact model to database rows. Mirrors the row shapes the
 * A1 classifier integration test inserts (a developer-owned fixture, not the SQL under test), written with
 * triggers disabled so a fixture can place any timestamp. Everything runs in the caller's transaction.
 */
export type OrgCtx = { org: string; owner: string; rep: string; otherRep: string; outsider: string; org2: string };

export type Materialized = {
  ctx: OrgCtx;
  /** lead key -> property id */
  ids: Map<string, string>;
  /** lead key -> message ref -> message id */
  messageIds: Map<string, Map<string, string>>;
  /** Decoy leads owned by another rep in the org and by another org: they must never appear in the rep's queue, counts or badge. */
  decoyIds: string[];
};

const iso = (ms: number) => new Date(ms).toISOString();

/** Fresh org with an owner, two reps (acquisitions enabled) and an outsider org, like the classifier test's world. */
export async function setupOrg(db: Client): Promise<OrgCtx> {
  const org = randomUUID(), owner = randomUUID(), rep = randomUUID(), otherRep = randomUUID(), outsider = randomUUID(), org2 = randomUUID();
  for (const id of [owner, rep, otherRep, outsider]) await db.query("insert into auth.users(id) values ($1)", [id]);
  await db.query("insert into public.organizations(id,name) values ($1,$2)", [org, `S1 stress ${org}`]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
  for (const id of [rep, otherRep]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
  await db.query("insert into public.organizations(id,name) values ($1,$2)", [org2, `S1 stress other ${org2}`]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [outsider, org2]);
  await db.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)", [org, owner]);
  await db.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)", [org2, outsider]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  for (const id of [owner, rep, otherRep]) {
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${owner}:${org}:${id}`]);
    await db.query("update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2", [id, org]);
  }
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");
  return { org, owner, rep, otherRep, outsider, org2 };
}

async function raw(db: Client, sql: string, params: unknown[]) {
  await db.query("set local session_replication_role='replica'");
  try { await db.query(sql, params); } catch (error) { throw error; }
  await db.query("set local session_replication_role='origin'");
}

const OUTBOUND_META = (m: Msg, rep: string): Record<string, unknown> => {
  const meta: Record<string, unknown> = {};
  switch (m.source) {
    case "approved_draft": meta.generated_by = "ai_responder_v1"; meta.approved_by_user_id = rep; break;
    case "ai_template": meta.generated_by = "ai_responder_v1"; meta.reply_source = "approved_template"; break;
    case "ai_written": meta.generated_by = "ai_responder_v1"; break;
    case "norma_precall": meta.generated_by = "norma_precall"; break;
    default: break;
  }
  if (m.outcome === "failed_unknown") meta.providerOutcome = "provider_unknown";
  if (m.stamp?.kind === "unresolved") meta.inbound_stamp_unresolved = true;
  return meta;
};

function statusOf(m: Msg): string {
  if (m.dir === "inbound") return "received";
  switch (m.outcome ?? "sent") {
    case "sent": return "sent";
    case "delivered": return "delivered";
    case "queued": return "queued";
    case "pending": return "pending";
    default: return "failed";
  }
}

export async function materializeWorld(db: Client, ctx: OrgCtx, world: World, opts: { member?: string; decoys?: boolean } = {}): Promise<Materialized> {
  const member = opts.member ?? ctx.rep;
  const ids = new Map<string, string>();
  const messageIds = new Map<string, Map<string, string>>();
  const contacts = new Map<string, string>();
  let phoneSeq = 0;
  const nextPhone = () => (phoneSeq += 1);
  for (const lead of world.leads) {
    const id = randomUUID();
    ids.set(lead.key, id);
    await insertLead(db, ctx, member, world.now, lead, id, nextPhone, messageIds, contacts);
  }
  const decoyIds: string[] = [];
  if (opts.decoys) {
    // Shapes that would land in Needs attention and the badge if the member or org filter leaked.
    const decoy = (key: string) => ({ ...world.leads[0]!, key, question: undefined, contactShared: false, contactGroup: undefined, pin: undefined,
      messages: [{ ref: "i", dir: "inbound" as const, at: world.now - HOUR, body: "decoy" }], appointments: [{ ref: "a", due: world.now - HOUR, status: "open" as const }],
      enrollment: undefined, offer: undefined, ledgers: [], obligations: [], events: [], missedCalls: [], stage: "contacted" as const });
    for (const [n, [c, who]] of ([[ctx, ctx.otherRep], [ctx, ctx.otherRep], [{ ...ctx, org: ctx.org2 }, ctx.outsider]] as const).entries()) {
      const id = randomUUID();
      decoyIds.push(id);
      await insertLead(db, c, who, world.now, decoy(`decoy${n}_${id.slice(0, 8)}`), id, nextPhone, new Map(), new Map());
    }
  }
  return { ctx, ids, messageIds, decoyIds };
}

async function insertLead(db: Client, ctx: OrgCtx, member: string, now: number, lead: Lead, id: string, nextPhone: () => number, messageIds: Map<string, Map<string, string>>, contacts: Map<string, string>) {
  const { org } = ctx;
  const shared = lead.contactGroup ? contacts.get(lead.contactGroup) : undefined;
  const contact = shared ?? randomUUID();
  if (lead.contactGroup) contacts.set(lead.contactGroup, contact);
  const phone = lead.hasPhone ? `+181655${String(nextPhone() + 10000).padStart(5, "0")}` : null;
  if (!shared) await db.query("insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,$3,$4,$5,$6)",
    [contact, org, lead.key, "Lead", phone, phone ? "mobile" : "unknown"]);
  await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4,$5)",
    [id, org, `${lead.key} Stress`, member, contact]);
  if (lead.dnc) await raw(db, "update public.contacts set do_not_contact=true where id=$1", [contact]);
  // `not_contacted` is the absence of a queue-state row (the stored stages are contacted / needs_offer / offer_sent / under_contract).
  if (lead.stage !== "not_contacted") await db.query(
    `insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at) values ($1,$2,$3,$4)
     on conflict (property_id,org_id) do update set stage=excluded.stage, stage_entered_at=excluded.stage_entered_at`,
    [id, org, lead.stage, iso(now - HOUR)]);
  await raw(db, "update public.acquisition_assignment_episodes set assigned_at=$2 where property_id=$1 and ended_at is null", [id, iso(lead.assignedAt)]);

  for (const a of lead.attempts) {
    await raw(db,
      "insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,recorded_at,idempotency_key,outcome) values ($1,$2,$3,'outreach','manual',$4,$4,$5,$6)",
      [org, id, member, iso(a.at), randomUUID(), a.outcome]);
  }

  // enrollment first: drip texts reference it
  let enr: { enr: string; steps: string[] } | null = null;
  if (lead.enrollment) {
    const e = lead.enrollment;
    const seq = randomUUID(), enrId = randomUUID();
    await raw(db, "insert into public.sequences(id,org_id,name) values ($1,$2,$3)", [seq, org, `Warm check-in ${seq}`]);
    const steps: string[] = [];
    for (let i = 0; i < e.steps; i += 1) {
      const sid = randomUUID();
      steps.push(sid);
      await raw(db, "insert into public.sequence_steps(id,sequence_id,step_index,action_type,template_body) values ($1,$2,$3,'send_sms','hello')", [sid, seq, i]);
    }
    await raw(db,
      `insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,current_step_index,next_run_at,pause_reason,updated_at,enrolled_by_user_id,enrolled_at,completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [enrId, org, seq, id, e.status, e.step, e.nextRunAt === null ? null : iso(e.nextRunAt), e.pause ?? null, iso(e.updatedAt), e.enrolledBy === "rep" ? member : null, iso(e.enrolledAt), e.completedAt ? iso(e.completedAt) : null]);
    enr = { enr: enrId, steps };
    if (e.claimAt !== undefined) {
      await raw(db, "insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for,claim_active,attempt_outcome,attempt_started_at) values ($1,$2,$3,true,'unknown',$3)",
        [enrId, steps[Math.min(e.step, steps.length - 1)], iso(e.claimAt)]);
    }
  }

  const refs = new Map<string, string>();
  messageIds.set(lead.key, refs);
  for (const m of lead.messages) refs.set(m.ref, randomUUID());
  const idOf = (ref: string) => refs.get(ref)!;
  const sourceIds = new Map<string, string>(); // dismissal targets

  for (const m of lead.messages) {
    const mid = idOf(m.ref);
    const meta = m.dir === "outbound" ? OUTBOUND_META(m, member) : {};
    if (m.stamp?.kind === "inbound") meta.inbound_message_id = m.stamp.lead === undefined || m.stamp.lead === lead.key ? idOf(m.stamp.ref) : messageIds.get(m.stamp.lead)!.get(m.stamp.ref)!;
    if (m.stamp?.kind === "foreign") meta.inbound_message_id = randomUUID();
    const out = m.dir === "outbound";
    const outcome = m.outcome ?? "sent";
    const sentAt = !out ? null
      : outcome === "sent" || outcome === "delivered" ? (m.sentAt ?? null)
      : outcome === "accepted_then_failed" ? (m.sentAt ?? m.at) : null;
    const deliveredAt = out && outcome === "delivered" ? (m.sentAt ?? m.at) : null;
    const failedAt = out && (outcome === "failed" || outcome === "failed_unknown" || outcome === "accepted_then_failed") ? (m.failedAt ?? null) : null;
    await raw(db,
      `insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata,campaign_id,scheduled_for,sent_at,delivered_at,failed_at)
       values ($1,$2,'sms',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [mid, org, m.dir, m.body === "" ? " " : m.body, statusOf(m), m.contactOnly ? null : id, contact, iso(m.at), JSON.stringify(meta),
       m.source === "campaign" ? randomUUID() : null, m.scheduledFor === undefined ? null : iso(m.scheduledFor),
       sentAt === null ? null : iso(sentAt), deliveredAt === null ? null : iso(deliveredAt), failedAt === null ? null : iso(failedAt)]);
    if (m.source === "drip" && enr) {
      const stepIdx = m.dripFinal ? enr.steps.length - 1 : 0;
      await raw(db, "insert into public.sequence_step_runs(enrollment_id,step_id,message_id,scheduled_for,run_at) values ($1,$2,$3,$4,$4)",
        [enr.enr, enr.steps[stepIdx], mid, iso(m.at)]);
    }
    if (m.ledger) {
      const lid = await insertLedger(db, ctx, member, id, contact, m.ledger.state, m.ledger.updatedAt, mid);
      sourceIds.set(`ledger:${m.ref}`, lid);
    }
    sourceIds.set(m.ref, mid);
  }
  for (const l of lead.ledgers) sourceIds.set(l.ref, await insertLedger(db, ctx, member, id, contact, l.state, l.updatedAt, null));
  for (const o of lead.obligations) {
    const oid = randomUUID();
    const claimed = o.state === "claimed" || o.state === "sending";
    const complete = ["accepted", "delivered", "delivery_failed", "voided", "exception_closed"].includes(o.state);
    const authorized = ["sending", "accepted", "delivered", "unknown", "delivery_failed"].includes(o.state);
    await raw(db,
      `insert into public.rep_sms_obligations(id,org_id,property_id,attempt_id,actor_user_id,state,claim_state,claim_token,claimed_by,claimed_at,lease_expires_at,authorized_at,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
      [oid, org, id, randomUUID(), member, o.state, claimed ? "claimed" : complete ? "complete" : "unclaimed",
       claimed || complete ? randomUUID() : null, claimed ? member : null, claimed ? iso(o.updatedAt) : null, claimed ? iso(o.leaseExpiresAt ?? o.updatedAt) : null,
       authorized ? iso(o.updatedAt) : null, iso(o.updatedAt)]);
    sourceIds.set(o.ref, oid);
  }

  for (const c of lead.missedCalls) {
    await raw(db,
      "insert into public.call_activities(org_id,property_id,contact_id,jitter_attempt_id,jitter_session_id,direction,started_at,ended_at,talk_duration_seconds) values ($1,$2,$3,$4,$4,'inbound',$5,$5,0)",
      [org, id, contact, randomUUID(), iso(c)]);
  }

  for (const e of lead.events) {
    if (e.type === "note") {
      await raw(db, "insert into public.lead_notes(org_id,property_id,author_user_id,body,created_at) values ($1,$2,$3,'note',$4)", [org, id, member, iso(e.at)]);
      continue;
    }
    const src = e.dismisses ? sourceIds.get(e.dismisses) ?? null : null;
    await raw(db,
      "insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [org, id, e.actor, e.actor === "user" ? member : null, e.type, JSON.stringify(e.operation ? { operation: e.operation } : {}), src ? "rep_sms" : null, src, iso(e.at)]);
  }

  const chain = randomUUID();
  for (const a of lead.appointments) {
    const end = new Date(a.due + 15 * 60_000).toISOString();
    const outcome = a.status === "completed" ? "held" : a.status === "cancelled" ? "cancelled" : null;
    await raw(db,
      "insert into public.tasks(org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id,snoozed_until,outcome,source_key) values ($1,'appointment',$2,'appointment task',$3,$4,$5,$5,$6,$7,$8,$9,null)",
      [org, a.status, iso(a.due), end, member, a.offerChain ? chain : randomUUID(), id, a.snoozedUntil === undefined ? null : iso(a.snoozedUntil), outcome]);
  }
  if (lead.offer) {
    const o = lead.offer;
    await raw(db,
      `insert into public.acquisition_offers(org_id,property_id,actor_user_id,amount_cents,sent_via,sent_at,follow_up_at,outcome,outcome_at,outcome_by,idempotency_key,follow_up_calendar_chain_id)
       values ($1,$2,$3,150000,'verbal',$4,$5,$6,$7,$8,$9,$10)`,
      [org, id, member, iso(o.sentAt), iso(o.followUpAt), o.outcome, o.outcome === "pending" ? null : iso(o.sentAt + HOUR), o.outcome === "pending" ? null : member, randomUUID(), o.hasChain ? chain : null]);
  }
  if (lead.pin) {
    // A pin with no expiry is the Phase B shape; until that migration lands the check forbids it, so drop it (rolled back with the world).
    if (lead.pin.until === null) await raw(db, "alter table public.my_leads_strip_overrides drop constraint if exists my_leads_strip_overrides_one_kind_check", []);
    await raw(db, "insert into public.my_leads_strip_overrides(org_id,member_id,property_id,pinned_at,pinned_until) values ($1,$2,$3,$4,$5)",
      [org, member, id, iso(lead.pin.pinnedAt), lead.pin.until === null ? null : iso(lead.pin.until)]);
  }
  if (lead.aiDraftPending) await raw(db, "insert into public.ai_reply_drafts(org_id,property_id,body,source,status,created_at) values ($1,$2,'draft','llm','pending',$3)", [org, id, iso(now - 2 * HOUR)]);
  if (lead.aiDeadLetter !== undefined) await raw(db, "insert into public.ai_reply_dead_letters(org_id,property_id,body,reason,created_at) values ($1,$2,'x','failed',$3)", [org, id, iso(lead.aiDeadLetter)]);
  if (lead.normaNeedsReview || lead.normaCalling) {
    await raw(db,
      "insert into public.norma_call_requests(org_id,property_id,phone_e164,callback_assignee_id,status,created_at,updated_at) values ($1,$2,'+18165550102',$3,$4,$5,$5)",
      [org, id, member, lead.normaNeedsReview ? "needs_review" : "dispatched", iso(now - HOUR)]);
  }
}

async function insertLedger(db: Client, ctx: OrgCtx, member: string, property: string, contact: string, state: LedgerState, updatedAt: number, messageId: string | null): Promise<string> {
  const lid = randomUUID();
  await raw(db,
    `insert into public.rep_sms_delivery_ledger(id,org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,provider,provider_account_id,provider_sender_id,from_number,to_number,body,state,claim_token,message_id,created_at,updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,'sendillo','acct','sender','+18165550100','+18165550101','hi',$8,$9,$10,$11,$11)`,
    [lid, ctx.org, member, randomUUID(), property, contact, randomUUID(), state, randomUUID(), messageId, iso(updatedAt)]);
  return lid;
}

/** Row counts the committed lanes must leave exactly as they found them. */
export async function footprint(db: Client): Promise<Record<string, number>> {
  // Every public base table plus auth.users: whatever a fixture writes, directly or through a trigger, is counted.
  const tables = ["auth.users", ...(await db.query("select format('%I.%I', table_schema, table_name) as t from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1")).rows.map((r) => r.t as string)];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await db.query(`select count(*)::int as n from ${t}`)).rows[0].n);
  return out;
}

/**
 * Delete everything a committed lane created for one org context: the two orgs (and everything that hangs off them) and the four users.
 * Rows whose foreign keys do not cascade are deleted explicitly first. Designated reps are un-designated through the same guarded path
 * setupOrg used, so the my-leads designation trigger accepts it. Runs in its own transaction.
 */
export async function purgeOrg(db: Client, ctx: OrgCtx): Promise<void> {
  const orgs = [ctx.org, ctx.org2];
  const users = [ctx.owner, ctx.rep, ctx.otherRep, ctx.outsider];
  await db.query("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [ctx.owner]);
    for (const u of [ctx.owner, ctx.rep, ctx.otherRep]) {
      await db.query("select set_config('my_leads.designation_update',$1,true)", [`${ctx.owner}:${ctx.org}:${u}`]);
      await db.query("update public.memberships set acquisitions_enabled=false where user_id=$1 and org_id=$2 and acquisitions_enabled", [u, ctx.org]);
    }
    await db.query("select set_config('my_leads.designation_update','',true)");
    // Everything keyed by these orgs, children before parents, with triggers off so guard/audit triggers do not block a test teardown.
    await db.query("set local session_replication_role='replica'");
    // Children first, by the keys the fixtures write through (steps/runs have no org_id), then every org-keyed table.
    const ids = async (sql: string) => (await db.query(sql, [orgs])).rows.map((r) => r.id as string);
    const keys: Record<string, string[]> = {
      enrollment_id: await ids("select id from public.sequence_enrollments where org_id = any($1::uuid[])"),
      sequence_id: await ids("select id from public.sequences where org_id = any($1::uuid[])"),
      property_id: await ids("select id from public.properties where org_id = any($1::uuid[])"),
      contact_id: await ids("select id from public.contacts where org_id = any($1::uuid[])"),
      message_id: await ids("select id from public.messages where org_id = any($1::uuid[])"),
    };
    const cols = (await db.query(
      `select format('%I.%I', c.table_schema, c.table_name) as t, c.column_name as col from information_schema.columns c
         join information_schema.tables t using (table_schema, table_name)
        where c.table_schema='public' and t.table_type='BASE TABLE' and c.data_type='uuid'
          and c.column_name in ('enrollment_id','sequence_id','property_id','contact_id','message_id','org_id')`)).rows as Array<{ t: string; col: string }>;
    for (const key of ["enrollment_id", "sequence_id", "message_id", "property_id", "contact_id"]) {
      if (!keys[key]!.length) continue;
      for (const c of cols.filter((x) => x.col === key)) await db.query(`delete from ${c.t} where ${key} = any($1::uuid[])`, [keys[key]]);
    }
    for (const c of cols.filter((x) => x.col === "org_id")) await db.query(`delete from ${c.t} where org_id = any($1::uuid[])`, [orgs]);
    // Replica mode disables ON DELETE CASCADE, so rows keyed only by the lane's users are deleted explicitly too.
    const userCols = (await db.query(
      `select format('%I.%I', c.table_schema, c.table_name) as t from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
        where c.table_schema='public' and t.table_type='BASE TABLE' and c.data_type='uuid' and c.column_name='user_id'`)).rows as Array<{ t: string }>;
    for (const c of userCols) await db.query(`delete from ${c.t} where user_id = any($1::uuid[])`, [users]);
    await db.query("delete from public.organizations where id = any($1::uuid[])", [orgs]);
    await db.query("delete from auth.users where id = any($1::uuid[])", [users]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}
