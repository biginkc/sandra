import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { applyNormaFollowups } from "../../tests/integration/norma-followup-fixture";
import { describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
async function fixture(fn: (db: Client, ids: { org: string; other: string; user: string; property: string; foreign: string }) => Promise<void>) {
  const db = new Client({ connectionString: url }); await db.connect();
  try {
    await db.query("begin");
    // Both follow-ups replay after the canonical dependency in one rollback-only fixture.
    await applyNormaFollowups(db);
    const ids = { org: randomUUID(), other: randomUUID(), user: randomUUID(), property: randomUUID(), foreign: randomUUID() };
    await db.query("insert into auth.users(id,email) values($1,$2)", [ids.user,`${ids.user}@example.invalid`]);
    await db.query("insert into organizations(id,name) values($1,'Norma fixture'),($2,'Other fixture')", [ids.org, ids.other]);
    const owner=randomUUID();
    await db.query("insert into auth.users(id) values($1)",[owner]);
    await db.query("insert into memberships(user_id,org_id,role,access_status) values($1,$2,'owner','active')",[owner,ids.org]);
    await db.query("insert into memberships(user_id,org_id,role,access_status) values($1,$2,'member','active')", [ids.user,ids.org]);
    await db.query("insert into properties(id,org_id,address,state,status) values($1,$2,'1 Fixture Lane','MO','new_lead'),($3,$4,'2 Fixture Lane','MO','new_lead')", [ids.property,ids.org,ids.foreign,ids.other]);
    await db.query("insert into norma_inbound_destinations(phone_e164,org_id,enabled) values('+18165551002',$1,true),('+18165551003',$2,true)", [ids.org,ids.other]);
    await fn(db, ids);
  } finally { await db.query("rollback").catch(() => {}); await db.end(); }
}
async function service(db: Client, query: string, args: unknown[] = []) {
  const previousRole=(await db.query("select current_setting('request.jwt.claim.role',true) value")).rows[0].value ?? "";
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  await db.query("set local role service_role");
  try { return await db.query(query,args); } finally {
    await db.query("reset role").catch(() => {});
    await db.query("select set_config('request.jwt.claim.role',$1,true)",[previousRole]).catch(() => {});
  }
}
async function member(db: Client,user: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[user]);
  await db.query("set local role authenticated");
}
const ingest = (db: Client,state="pending",completed=false) => service(db,"select fn_norma_ingest_inbound_call('call-1','+18165551001','+18165551002',$1,$2) id",[completed,state]);
describe("Norma inbound ledger with Sandra schema", () => {
  it("deduplicates and preserves completion/recording evidence across late events", () => fixture(async(db) => {
    await ingest(db); await ingest(db,"reported_available",true); await ingest(db);
    const rows=(await db.query("select * from norma_inbound_calls")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({completed:true,recording_state:"reported_available",review_state:"needs_review",property_id:null});
  }));
  it("returns retryable absence for unknown and disabled destinations", () => fixture(async(db) => {
    await db.query("update norma_inbound_destinations set enabled=false");
    expect((await ingest(db)).rows[0].id).toBeNull();
    expect((await service(db,"select fn_norma_ingest_inbound_call('other','+18165551001','+18165551999',true,'pending') id")).rows[0].id).toBeNull();
  }));
  it.each(["+18165551003","+18165551002"])("rejects a call identity replay with changed destination/from (%s)",(to) => fixture(async(db) => {
    await ingest(db);
    await expect(service(db,"select fn_norma_ingest_inbound_call('call-1',$1,$2,true,'pending')",[to.endsWith("003")?"+18165551001":"+18165551999",to])).rejects.toMatchObject({code:"23514"});
  }));
  it("allows active members to read and excludes foreign or suspended members", () => fixture(async(db,ids) => {
    await ingest(db); await member(db,ids.user);
    expect((await db.query("select id from norma_inbound_calls")).rows).toHaveLength(1);
    await db.query("reset role"); await db.query("update memberships set access_status='suspended' where user_id=$1",[ids.user]); await member(db,ids.user);
    expect((await db.query("select id from norma_inbound_calls")).rows).toHaveLength(0);
  }));
  it("audits explicit association once and preserves it through late events", () => fixture(async(db,ids) => {
    const id=(await ingest(db)).rows[0].id; const stamp=(await db.query("select updated_at::text updated_at from norma_inbound_calls where id=$1",[id])).rows[0].updated_at;
    await member(db,ids.user);
    for(let i=0;i<2;i++) await db.query("select fn_norma_associate_inbound_call($1,$2,$3)",[id,ids.property,stamp]);
    expect((await db.query("select * from norma_inbound_reviews")).rows).toHaveLength(1);
    await db.query("reset role"); await ingest(db,"reported_available",true);
    expect((await db.query("select property_id,reviewed_by from norma_inbound_calls where id=$1",[id])).rows[0]).toEqual({property_id:ids.property,reviewed_by:ids.user});
  }));
  it("rejects cross-org property association", () => fixture(async(db,ids) => {
    const id=(await ingest(db)).rows[0].id; const stamp=(await db.query("select updated_at::text updated_at from norma_inbound_calls where id=$1",[id])).rows[0].updated_at;
    await member(db,ids.user);
    await expect(db.query("select fn_norma_associate_inbound_call($1,$2,$3)",[id,ids.foreign,stamp])).rejects.toMatchObject({code:"22023"});
  }));
  it("rejects stale review actions", () => fixture(async(db,ids) => {
    const id=(await ingest(db)).rows[0].id; await member(db,ids.user);
    await expect(db.query("select fn_norma_associate_inbound_call($1,$2,'2000-01-01')",[id,ids.property])).rejects.toMatchObject({code:"40001"});
  }));
  it("denies restricted acquisition members at the database boundary", () => fixture(async(db,ids) => {
    const id=(await ingest(db)).rows[0].id;
    const owner=(await db.query("select user_id from memberships where org_id=$1 and role='owner'",[ids.org])).rows[0].user_id;
    await member(db,owner);
    await db.query("select fn_set_acquisition_designation($1,$2,true,false,$3)",[ids.org,ids.user,randomUUID()]);
    await db.query("reset role");
    await member(db,ids.user);
    expect((await db.query("select id from norma_inbound_calls")).rows).toHaveLength(0);
    await expect(db.query("select fn_norma_associate_inbound_call($1,$2,now())",[id,ids.property])).rejects.toMatchObject({code:"42501"});
  }));
  it("denies a member of a different organization", () => fixture(async(db,ids) => {
    const id=(await ingest(db)).rows[0].id;const foreignUser=randomUUID();
    await db.query("insert into auth.users(id) values($1)",[foreignUser]);
    await db.query("insert into memberships(user_id,org_id,role,access_status) values($1,$2,'owner','active')",[foreignUser,ids.other]);
    await member(db,foreignUser);
    expect((await db.query("select id from norma_inbound_calls")).rows).toHaveLength(0);
    await expect(db.query("select fn_norma_associate_inbound_call($1,$2,now())",[id,ids.property])).rejects.toMatchObject({code:"42501"});
  }));
  it("does not permit silent reassociation to another property", () => fixture(async(db,ids) => {
    const id=(await ingest(db)).rows[0].id;const stamp=(await db.query("select updated_at::text updated_at from norma_inbound_calls where id=$1",[id])).rows[0].updated_at;
    const otherProperty=randomUUID();await db.query("insert into properties(id,org_id,address,state,status) values($1,$2,'3 Fixture Lane','MO','new_lead')",[otherProperty,ids.org]);
    await member(db,ids.user);await db.query("select fn_norma_associate_inbound_call($1,$2,$3)",[id,ids.property,stamp]);
    const current=(await db.query("select updated_at::text updated_at from norma_inbound_calls where id=$1",[id])).rows[0].updated_at;
    await expect(db.query("select fn_norma_associate_inbound_call($1,$2,$3)",[id,otherProperty,current])).rejects.toMatchObject({code:"22023"});
  }));
  it("preserves call association and original audit identity through a property merge", () => fixture(async(db,ids) => {
    const id=(await ingest(db)).rows[0].id;const stamp=(await db.query("select updated_at::text updated_at from norma_inbound_calls where id=$1",[id])).rows[0].updated_at;
    const keeper=randomUUID();await db.query("insert into properties(id,org_id,address,state,status) values($1,$2,'4 Fixture Lane','MO','new_lead')",[keeper,ids.org]);
    await member(db,ids.user);await db.query("select fn_norma_associate_inbound_call($1,$2,$3)",[id,ids.property,stamp]);
    await db.query("select merge_duplicate_properties($1,$2)",[keeper,ids.property]);
    expect((await db.query("select property_id from norma_inbound_calls where id=$1",[id])).rows[0].property_id).toBe(keeper);
    expect((await db.query("select property_id,property_id_snapshot from norma_inbound_reviews where call_id=$1",[id])).rows[0]).toEqual({property_id:keeper,property_id_snapshot:ids.property});
  }));
  it("retains evidence when an associated property is deleted", () => fixture(async(db,ids) => {
    const id=(await ingest(db)).rows[0].id;const stamp=(await db.query("select updated_at::text updated_at from norma_inbound_calls where id=$1",[id])).rows[0].updated_at;
    await member(db,ids.user);await db.query("select fn_norma_associate_inbound_call($1,$2,$3)",[id,ids.property,stamp]);await db.query("reset role");
    await db.query("delete from properties where id=$1",[ids.property]);
    expect((await db.query("select property_id,review_state from norma_inbound_calls where id=$1",[id])).rows[0]).toEqual({property_id:null,review_state:"associated"});
    expect((await db.query("select property_id_snapshot from norma_inbound_reviews where call_id=$1",[id])).rows[0].property_id_snapshot).toBe(ids.property);
  }));
  it("denies anonymous association and direct service-role review function calls", () => fixture(async(db) => {
    expect((await db.query("select has_function_privilege('anon','public.fn_norma_associate_inbound_call(uuid,uuid,timestamptz)','execute') anon,has_function_privilege('service_role','norma_private.associate_inbound_call(uuid,uuid,timestamptz)','execute') service")).rows[0]).toEqual({anon:false,service:false});
  }));
  it("leases at most five eligible lookups and never immediately reclaims them", () => fixture(async(db) => {
    await db.query("update norma_inbound_destinations set recording_lookup_enabled=true");
    for(let i=0;i<7;i++)await service(db,"select fn_norma_ingest_inbound_call($1,'+18165551001','+18165551002',true,'pending')",[`call-${i}`]);
    const batch=(await service(db,"select * from fn_norma_claim_inbound_recordings()")).rows;expect(batch).toHaveLength(5);
    expect((await service(db,"select id from fn_norma_claim_inbound_recordings()")).rows).toHaveLength(0);
    await service(db,"select fn_norma_finish_inbound_lookup($1,false)",[batch[0].lease_id]);
    expect((await service(db,"select id from fn_norma_claim_inbound_recordings()")).rows).toHaveLength(2);
    expect((await service(db,"select id from fn_norma_claim_inbound_recordings()")).rows).toHaveLength(0);
    expect((await db.query("select distinct reconciliation_attempts from norma_inbound_calls")).rows).toEqual([{reconciliation_attempts:1}]);
  }));
  it("does not look up recordings until explicitly enabled and globally pauses on denial", () => fixture(async(db) => {
    await ingest(db);
    expect((await service(db,"select id from fn_norma_claim_inbound_recordings()")).rows).toHaveLength(0);
    await db.query("update norma_inbound_destinations set recording_lookup_enabled=true");
    await service(db,"select fn_norma_pause_inbound_lookups()");
    expect((await service(db,"select id from fn_norma_claim_inbound_recordings()")).rows).toHaveLength(0);
    expect((await db.query("select bool_and(enabled) enabled,bool_or(recording_lookup_enabled) lookup from norma_inbound_destinations")).rows[0]).toEqual({enabled:true,lookup:false});
  }));
  it("makes an exhausted crashed claim terminal after its lease expires", () => fixture(async(db) => {
    await ingest(db);await db.query("update norma_inbound_calls set reconciliation_attempts=6,next_lookup_at=now()-interval '1 minute'");
    await service(db,"select id from fn_norma_claim_inbound_recordings()");
    expect((await db.query("select reconciliation_state from norma_inbound_calls")).rows[0].reconciliation_state).toBe("unavailable");
  }));
  it("does not grant authenticated users ingestion or direct writes", () => fixture(async(db,ids) => {
    await member(db,ids.user);
    const r=(await db.query("select has_function_privilege(current_user,'public.fn_norma_ingest_inbound_call(text,text,text,boolean,text)','execute') ingest,has_table_privilege(current_user,'public.norma_inbound_calls','update') writes")).rows[0];
    expect(r).toEqual({ingest:false,writes:false});
  }));
  it("replays the full dependency chain twice inside one rollback transaction", () => fixture(async(db) => {
    await applyNormaFollowups(db);
    const result=(await db.query("select to_regclass('public.norma_inbound_calls') is not null inbound, to_regclass('public.norma_attempt_recordings') is not null outbound, exists(select 1 from pg_proc where proname='fn_norma_presend_fence') fence")).rows[0];
    expect(result).toEqual({inbound:true,outbound:true,fence:true});
    expect((await db.query("select enabled,awaiting_result from norma_recording_lookup_control")).rows[0]).toEqual({enabled:false,awaiting_result:false});
  }));

  it("retains an uncertain-result barrier across lease expiry and a failed denial write", () => fixture(async(db) => {
    await ingest(db);await db.query("update norma_inbound_destinations set recording_lookup_enabled=true");
    const c=(await service(db,"select * from fn_norma_claim_inbound_recordings()")).rows[0];
    expect((await service(db,"select fn_norma_start_inbound_lookup($1,$2) ok",[c.lease_id,c.id])).rows[0].ok).toBe(true);
    await db.query("savepoint denial_write");
    await db.query("create function pg_temp.reject_pause() returns trigger language plpgsql as $$ begin raise exception 'test pause write failure'; end $$; create trigger test_pause_failure before update on norma_inbound_destinations for each row execute function pg_temp.reject_pause()");
    await expect(service(db,"select fn_norma_finish_inbound_lookup($1,true)",[c.lease_id])).rejects.toThrow("test pause write failure");
    await db.query("rollback to savepoint denial_write");
    await db.query("update norma_inbound_lookup_control set lease_until=now()-interval '1 minute'");
    expect((await service(db,"select * from fn_norma_claim_inbound_recordings()")).rows).toHaveLength(0);
    expect((await db.query("select awaiting_result,denied_at from norma_inbound_lookup_control")).rows[0]).toEqual({awaiting_result:true,denied_at:null});
  }));
  it("stops previously claimed work after a denial, including a stale worker denial", () => fixture(async(db) => {
    await ingest(db);await db.query("update norma_inbound_destinations set recording_lookup_enabled=true");
    const c=(await service(db,"select * from fn_norma_claim_inbound_recordings()")).rows[0];
    // A stale worker cannot release another lease, but its denial must still stop admission.
    await service(db,"select fn_norma_finish_inbound_lookup($1,true)",[randomUUID()]);
    expect((await service(db,"select fn_norma_start_inbound_lookup($1,$2) ok",[c.lease_id,c.id])).rows[0].ok).toBe(false);
    expect((await service(db,"select * from fn_norma_claim_inbound_recordings()")).rows).toHaveLength(0);
    expect((await db.query("select lease_id,denied_at is not null denied from norma_inbound_lookup_control")).rows[0]).toEqual({lease_id:c.lease_id,denied:true});
  }));
  it("preserves a newer webhook while clearing a matching known-result barrier", () => fixture(async(db) => {
    await ingest(db);await db.query("update norma_inbound_destinations set recording_lookup_enabled=true");
    const c=(await service(db,"select * from fn_norma_claim_inbound_recordings()")).rows[0];
    await service(db,"select fn_norma_start_inbound_lookup($1,$2)",[c.lease_id,c.id]);
    await ingest(db,"reported_available",true);
    expect((await service(db,"select fn_norma_checkpoint_inbound_lookup($1,$2,$3,'pending') ok",[c.id,c.reconciliation_attempts,c.lease_id])).rows[0].ok).toBe(true);
    expect((await db.query("select recording_state,reconciliation_state from norma_inbound_calls where id=$1",[c.id])).rows[0]).toEqual({recording_state:"reported_available",reconciliation_state:"done"});
    expect((await db.query("select awaiting_result from norma_inbound_lookup_control")).rows[0].awaiting_result).toBe(false);
  }));
  it("denies authenticated users all new admission controls", () => fixture(async(db,ids) => {
    await member(db,ids.user);
    expect((await db.query("select has_table_privilege(current_user,'norma_inbound_lookup_control','select') readable,has_function_privilege(current_user,'fn_norma_start_inbound_lookup(uuid,uuid)','execute') start,has_function_privilege(current_user,'fn_norma_checkpoint_inbound_lookup(uuid,smallint,uuid,text)','execute') checkpoint,has_function_privilege(current_user,'fn_norma_finish_inbound_lookup(uuid,boolean)','execute') finish")).rows[0]).toEqual({readable:false,start:false,checkpoint:false,finish:false});
  }));
});
