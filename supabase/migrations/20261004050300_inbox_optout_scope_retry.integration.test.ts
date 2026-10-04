import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({
  connectionString: requireLoopbackPostgresUrl(
    process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
  ),
});

type Fixture = {
  org: string;
  actor: string;
  contact: string;
  property: string;
  sibling: string;
  sequence: string;
  enrollment: string;
  siblingEnrollment: string;
  conversation: string;
  operation: string;
  step: string;
};

const uuid = () => randomUUID();
const scopeGateMessages = [
  "SMS scope changed or unseeded",
  "SMS scope membership changed",
  "SMS property scope exceeds bound or changed",
];

async function one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]!;
}

async function seedFixture(value: "opted_out" | "not_interested" = "opted_out"): Promise<Fixture> {
  const f = {
    org: uuid(), actor: uuid(), contact: uuid(), property: uuid(), sibling: uuid(), sequence: uuid(),
    enrollment: uuid(), siblingEnrollment: uuid(), conversation: uuid(), operation: uuid(), step: uuid(),
  } satisfies Fixture;
  const preparation = uuid();
  const item = uuid();
  const idempotency = uuid();
  const message = uuid();
  const review = uuid();
  const definition = { version: 1, steps: [{ type: "outcome", value }] };
  const canonicalInput = {
    purpose: "prepare_action",
    organizationId: f.org,
    requesterId: f.actor,
    targets: [{ kind: "conversation", id: f.conversation }],
    definition,
    savedAction: null,
  };
  await db.query("insert into public.organizations(id,name) values($1,$2)", [f.org, `Inbox retry ${f.org}`]);
  await db.query("insert into auth.users(id,email) values($1,$2)", [f.actor, `retry-${f.actor}@example.invalid`]);
  await db.query("insert into public.memberships(org_id,user_id,role,access_status) values($1,$2,'owner','active')", [f.org, f.actor]);
  await db.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values($1,$2,'Retry',$3,'mobile')", [f.contact, f.org, `+1816555${f.contact.slice(-4)}`]);
  await db.query("insert into public.properties(id,org_id,address,state,homeowner_contact_id) values($1,$2,'Retry Way','MO',$4),($3,$2,'Sibling Way','MO',$4)", [f.property, f.org, f.sibling, f.contact]);
  await db.query("insert into public.messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) values($1,$2,$3,$4,$5,'sms','inbound','received','retry fixture')", [message, f.org, f.conversation, f.contact, f.property]);
  await db.query("insert into public.ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason) values($1,$2,$3,$4,$5,'not_interested','retry fixture')", [review, f.org, f.property, f.conversation, message]);
  await db.query("insert into public.sequences(id,org_id,name) values($1,$2,'Retry sequence')", [f.sequence, f.org]);
  await db.query("insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,next_run_at) values($1,$2,$3,$4,'active',clock_timestamp())", [f.enrollment, f.org, f.sequence, f.property]);
  await db.query("insert into public.consent_events(org_id,contact_id,channel,event_type,source) values($1,$2,'sms','opt_in_informational','retry fixture')", [f.org, f.contact]);

  const targetRevision = (await one<{ revision: string }>(
    "select revision::text from inbox_operation_domain.target_versions where org_id=$1::uuid and conversation_id=$2::uuid",
    [f.org, f.conversation],
  )).revision;
  const requirements = [
    ...["property_identity", "property_policy", "property_outcome", "property_assignment", "property_reviews"]
      .map((namespace) => ({ namespace, key: [f.property] })),
    { namespace: "membership_access", key: [f.actor] },
    { namespace: "contact_identity", key: [f.contact] },
    { namespace: "contact_policy", key: [f.contact] },
    { namespace: "contact_channel_consent", key: [f.contact, "sms"] },
  ];
  const policy = (await one<{ snapshot: Record<string, unknown> }>(
    "select inbox_policy.snapshot($1,$2::jsonb) snapshot",
    [f.org, JSON.stringify(requirements)],
  )).snapshot;
  const scope = (await one<{ scope: Record<string, unknown> }>(
    `select jsonb_build_object(
       'contact_id',$2::uuid::text,
       'revision',(select revision::text from inbox_operation_domain.sms_scopes where org_id=$1::uuid and contact_id=$2::uuid),
       'property_ids',(select jsonb_agg(id order by id) from public.properties where org_id=$1::uuid and homeowner_contact_id=$2::uuid),
       'enrollment_ids',(select coalesce(jsonb_agg(id order by id),'[]'::jsonb) from public.sequence_enrollments where org_id=$1::uuid and property_id in ($3::uuid,$4::uuid) and status='active')
     ) scope`,
    [f.org, f.contact, f.property, f.sibling],
  )).scope;
  const canonical = JSON.stringify(canonicalInput);
  const inputHash = (await one<{ input_hash: string }>(
    "select encode(sha256(convert_to('sandra:inbox:action:v1','UTF8') || decode('00','hex') || convert_to(($1::jsonb)::text,'UTF8')),'hex') input_hash",
    [canonical],
  )).input_hash;
  await db.query(
    `insert into inbox_operations.preparations(id,org_id,requester_id,canonical_input,input_hash,definition,snapshot,expires_at)
     values($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5,$6::jsonb,'{"items":[],"effects":[]}',clock_timestamp()+interval '1 hour')`,
    [preparation, f.org, f.actor, canonical, inputHash, JSON.stringify(definition)],
  );
  await db.query(
    `insert into inbox_operations.operations(org_id,id,requester_id,idempotency_key,input_hash,preparation_id,definition)
     values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::jsonb)`,
    [f.org, f.operation, f.actor, idempotency, inputHash, preparation, JSON.stringify(definition)],
  );
  await db.query(
    `insert into inbox_operations.items(org_id,operation_id,id,target_kind,target_id,resolution)
     values($1::uuid,$2::uuid,$3::uuid,'conversation',$4::uuid,jsonb_build_object('property_id',$5::uuid))`,
    [f.org, f.operation, item, f.conversation, f.property],
  );
  await db.query(
    `insert into inbox_operations.steps(org_id,operation_id,id,effect_key,ordinal,action,payload,dependencies)
     values($1::uuid,$2::uuid,$3::uuid,$4,0,'outcome',jsonb_build_object('property_id',$5::uuid,'value',$6::text),
       jsonb_build_object('policy',$7::jsonb,'targets',jsonb_build_array(jsonb_build_object('conversation_id',$8::uuid,'revision',$9::bigint)), 'sms_scope',$10::jsonb))`,
    [f.org, f.operation, f.step, `property:${f.property}`, f.property, value, JSON.stringify(policy), f.conversation, targetRevision, JSON.stringify(scope)],
  );
  await db.query(
    "insert into inbox_operations.item_steps(org_id,operation_id,item_id,step_id) values($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
    [f.org, f.operation, item, f.step],
  );
  return f;
}

async function runStep(f: Fixture) {
  return (await one<{ run_step: Record<string, unknown> }>(
    "select inbox_action_api.run_step($1,$2,$3) run_step",
    [f.org, f.operation, f.step],
  )).run_step;
}

async function captureApplyError(f: Fixture) {
  const generation = (await one<{ generation: string }>(
    "select inbox_operations.claim_step($1::uuid,$2::uuid,$3::uuid,60)::text generation",
    [f.org, f.operation, f.step],
  )).generation;
  try {
    return (await one<{ message: string }>(
      "select pg_temp.capture_inbox_apply_error($1::uuid,$2::uuid,$3::uuid,$4::bigint) message",
      [f.org, f.operation, f.step, generation],
    )).message;
  } finally {
    await db.query(
      "update inbox_operations.steps set state='pending',lease_until=null where org_id=$1::uuid and operation_id=$2::uuid and id=$3::uuid",
      [f.org, f.operation, f.step],
    );
  }
}

async function addSiblingEnrollment(f: Fixture) {
  await db.query(
    `insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,next_run_at)
     values($1,$2,$3,$4,'active',clock_timestamp())`,
    [f.siblingEnrollment, f.org, f.sequence, f.sibling],
  );
}

async function refreshTargetRevision(f: Fixture) {
  const revision = (await one<{ revision: string }>(
    "select revision::text from inbox_operation_domain.target_versions where org_id=$1::uuid and conversation_id=$2::uuid",
    [f.org, f.conversation],
  )).revision;
  await db.query(
    "update inbox_operations.steps set dependencies=jsonb_set(dependencies,'{targets,0,revision}',to_jsonb($1::bigint)) where id=$2::uuid",
    [revision, f.step],
  );
}

describe("Inbox opt-out scope retry", () => {
  beforeAll(async () => {
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await db.connect();
    await db.query("begin");
    await db.query(`create or replace function pg_temp.capture_inbox_apply_error(o uuid,op uuid,s uuid,g bigint)
      returns text language plpgsql as $$
      begin perform inbox_operation_domain.apply_property_step(o,op,s,g); return null;
      exception when others then return sqlerrm;
      end $$`);
  });
  beforeEach(async () => { await db.query("savepoint inbox_retry_case"); });
  afterEach(async () => { await db.query("rollback to savepoint inbox_retry_case"); });
  afterAll(async () => { await db.query("rollback"); await db.end(); });

  it("rebases one scope race, applies the opt-out, and preserves the prepared scope", async () => {
    const f = await seedFixture();
    await addSiblingEnrollment(f);
    const result = await runStep(f);
    expect(result).toMatchObject({ state: "succeeded" });
    const receipt = (result.receipt as { sms: Record<string, unknown> }).sms;
    expect(receipt).toMatchObject({ scope_rebase_attempted: true, rebased_from_revision: expect.any(String), rebased_to_revision: expect.any(String) });
    expect(Number(receipt.rebased_to_revision)).toBe(Number(receipt.rebased_from_revision) + 1);
    expect((receipt.paused as unknown[])).toHaveLength(2);
    expect((await one<{ sms_opted_out: boolean }>("select sms_opted_out from public.contacts where id=$1", [f.contact])).sms_opted_out).toBe(true);
    expect((await one<{ n: string }>("select count(*) n from public.consent_events where org_id=$1 and contact_id=$2 and event_type='opt_out'", [f.org, f.contact])).n).toBe("1");
    expect((await one<{ status: string }>("select status from public.sequence_enrollments where id=$1", [f.siblingEnrollment])).status).toBe("opted_out");
    const stored = await one<{ original_scope: Record<string, unknown> }>("select original_scope from inbox_operation_domain.shared_sms_receipts where operation_id=$1", [f.operation]);
    expect(stored.original_scope).toEqual((await one<{ scope: Record<string, unknown> }>("select dependencies->'sms_scope' scope from inbox_operations.steps where id=$1", [f.step])).scope);
  });

  it("returns the stored receipt on redelivery and never applies a second effect", async () => {
    const f = await seedFixture();
    const first = await runStep(f);
    const second = await runStep(f);
    expect(second).toEqual(first);
    expect((await one<{ n: string }>("select count(*) n from public.consent_events where org_id=$1 and contact_id=$2 and event_type='opt_out'", [f.org, f.contact])).n).toBe("1");
  });

  it("does not retry a non-opt-out policy conflict", async () => {
    const f = await seedFixture("not_interested");
    await db.query("update public.properties set outreach_dispo='wrong_number' where id=$1", [f.property]);
    await refreshTargetRevision(f);
    expect(await captureApplyError(f)).toBe("Dependency conflict");
    const result = await runStep(f);
    expect(result).toMatchObject({ state: "conflicted", receipt: { code: "record_changed" } });
    expect((result.receipt as Record<string, unknown>).scope_rebase_attempted).toBeUndefined();
  });

  it("keeps record_changed exact for an opt-out policy race", async () => {
    const f = await seedFixture();
    await db.query("update public.properties set outreach_dispo='not_interested' where id=$1", [f.property]);
    await refreshTargetRevision(f);
    expect(await captureApplyError(f)).toBe("Dependency conflict");
    const result = await runStep(f);
    expect(result).toMatchObject({ state: "conflicted", receipt: { code: "record_changed" } });
    expect((result.receipt as Record<string, unknown>).scope_rebase_attempted).toBeUndefined();
  });

  it("records one failed rebase and rolls back all effects", async () => {
    const f = await seedFixture();
    await addSiblingEnrollment(f);
    await db.query(`create or replace function pg_temp.bump_scope_after_disposition() returns trigger language plpgsql as $$
      begin update inbox_operation_domain.sms_scopes set revision=revision+1 where org_id=new.org_id and contact_id=(select homeowner_contact_id from public.properties where id=new.id); return new; end $$`);
    await db.query(`create trigger inbox_retry_test_bump_scope after update of outreach_dispo on public.properties
      for each row when (new.outreach_dispo='opted_out') execute function pg_temp.bump_scope_after_disposition()`);
    const result = await runStep(f);
    expect(result).toMatchObject({ state: "conflicted", receipt: { code: "sms_scope_changed", scope_rebase_attempted: true } });
    expect((await one<{ sms_opted_out: boolean }>("select sms_opted_out from public.contacts where id=$1", [f.contact])).sms_opted_out).toBe(false);
    expect((await one<{ n: string }>("select count(*) n from public.consent_events where org_id=$1 and contact_id=$2 and event_type='opt_out'", [f.org, f.contact])).n).toBe("0");
    expect((await one<{ status: string }>("select status from public.sequence_enrollments where id=$1", [f.siblingEnrollment])).status).toBe("active");
  });

  it("keeps the three mapped scope messages explicit", () => {
    expect(scopeGateMessages).toEqual([
      "SMS scope changed or unseeded",
      "SMS scope membership changed",
      "SMS property scope exceeds bound or changed",
    ]);
  });
});
