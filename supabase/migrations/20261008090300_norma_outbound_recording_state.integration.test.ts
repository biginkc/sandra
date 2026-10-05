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
async function request(db:Client,ids:{org:string;property:string;user:string},call: string | null="call-1") {
  const id=randomUUID();
  await db.query("insert into norma_call_requests(id,org_id,property_id,phone_e164,callback_assignee_id,bland_call_id) values($1,$2,$3,'+18165551001',$4,$5)",[id,ids.org,ids.property,ids.user,call]);
  return id;
}
const seed=(db:Client)=>service(db,"select fn_norma_seed_recordings() n");
const claim=(db:Client)=>service(db,"select * from fn_norma_claim_recordings()");
const enable=(db:Client)=>db.query("update norma_recording_lookup_control set enabled=true");
describe("outbound recording ledger on full Sandra schema",()=>{
  it("seeds legacy identities idempotently without affecting outcomes or notification rows",()=>fixture(async(db,ids)=>{
    const id=await request(db,ids);const before=(await db.query("select to_jsonb(r) row from norma_call_requests r where id=$1",[id])).rows;
    expect((await seed(db)).rows[0].n).toBe(1);expect((await seed(db)).rows[0].n).toBe(0);
    expect((await db.query("select request_id,attempt,provider_call_id,state from norma_attempt_recordings")).rows).toEqual([{request_id:id,attempt:1,provider_call_id:"call-1",state:"pending"}]);
    expect((await db.query("select to_jsonb(r) row from norma_call_requests r where id=$1",[id])).rows).toEqual(before);
    expect((await db.query("select * from norma_notifications where request_id=$1",[id])).rows).toHaveLength(0);
  }));
  it("supports the retry schema contract while attempt two is pending and after binding",()=>fixture(async(db,ids)=>{
    const id=await request(db,ids,"first");
    expect((await service(db,"select fn_norma_claim_dispatch($1,1) claimed",[id])).rows[0].claimed).toBe(true);
    expect((await service(db,"select fn_norma_complete_call($1,'first','no_answer','{\"attempt\":1}'::jsonb) result",[id])).rows[0].result).toMatchObject({retry:true});
    await seed(db);
    expect((await db.query("select attempt,provider_call_id from norma_attempt_recordings")).rows).toEqual([{attempt:1,provider_call_id:"first"}]);
    expect((await service(db,"select fn_norma_claim_dispatch($1,2) claimed",[id])).rows[0].claimed).toBe(true);
    expect((await service(db,"select fn_norma_bind_call_id($1,'second',2) result",[id])).rows[0].result).toBe("bound");
    await seed(db);
    expect((await db.query("select attempt,provider_call_id from norma_attempt_recordings order by attempt")).rows).toEqual([{attempt:1,provider_call_id:"first"},{attempt:2,provider_call_id:"second"}]);

  }));
  it("defaults off, globally leases only five, and leaves subsequent attempts unclaimed",()=>fixture(async(db,ids)=>{
    await request(db,ids);expect((await claim(db)).rows).toHaveLength(0);await enable(db);
    const first=(await claim(db)).rows;expect(first).toHaveLength(1);expect(first[0]).toMatchObject({attempt:1,lookup_attempts:1});
    expect((await claim(db)).rows).toHaveLength(0);
    await service(db,"select fn_norma_finish_recording_lookup($1,false)",[first[0].lease_id]);
    expect((await claim(db)).rows).toHaveLength(0); // Individual persisted backoff remains.
  }));
  it("retains monotonic evidence across repeated seeds and rejects stale checkpoints",()=>fixture(async(db,ids)=>{
    await request(db,ids);await enable(db);const call=(await claim(db)).rows[0];
    const args=[call.request_id,call.attempt,call.provider_call_id,call.lookup_attempts,call.lease_id];
    expect((await service(db,"select fn_norma_checkpoint_recording($1,$2,$3,$4,$5,'reported_available') saved",args)).rows[0].saved).toBe(true);
    expect((await service(db,"select fn_norma_checkpoint_recording($1,$2,$3,$4,$5,'pending') saved",args)).rows[0].saved).toBe(false);
    await seed(db);expect((await db.query("select state from norma_attempt_recordings")).rows[0].state).toBe("reported_available");
  }));
  it("persists access denial and requires explicit re-enablement",()=>fixture(async(db,ids)=>{
    await request(db,ids);await enable(db);const call=(await claim(db)).rows[0];
    await service(db,"select fn_norma_finish_recording_lookup($1,true)",[call.lease_id]);
    expect((await db.query("select enabled,denied_at is not null denied from norma_recording_lookup_control")).rows[0]).toEqual({enabled:false,denied:true});
    expect((await claim(db)).rows).toHaveLength(0);
  }));
  it("allows only members who can read the parent request and denies direct writes/RPCs",()=>fixture(async(db,ids)=>{
    await request(db,ids);await seed(db);await member(db,ids.user);
    expect((await db.query("select state from norma_attempt_recordings")).rows).toHaveLength(1);
    expect((await db.query("select has_table_privilege(current_user,'norma_attempt_recordings','update') writes,has_function_privilege(current_user,'fn_norma_seed_recordings()','execute') seed")).rows[0]).toEqual({writes:false,seed:false});
    await db.query("reset role");await db.query("update memberships set access_status='suspended' where user_id=$1",[ids.user]);await member(db,ids.user);
    expect((await db.query("select state from norma_attempt_recordings")).rows).toHaveLength(0);
  }));
  it("denies foreign organization reads and anonymous access",()=>fixture(async(db,ids)=>{
    await request(db,ids);await seed(db);const other=randomUUID();await db.query("insert into auth.users(id) values($1)",[other]);
    await db.query("insert into memberships(user_id,org_id,role,access_status) values($1,$2,'owner','active')",[other,ids.other]);await member(db,other);
    expect((await db.query("select state from norma_attempt_recordings")).rows).toHaveLength(0);
    expect((await db.query("select has_table_privilege('anon','norma_attempt_recordings','select') reads")).rows[0].reads).toBe(false);
  }));
  it("does not allow an expired worker to checkpoint or clear a newer lease",()=>fixture(async(db,ids)=>{
    await request(db,ids);await enable(db);const call=(await claim(db)).rows[0];const newer=randomUUID();
    await db.query("update norma_recording_lookup_control set lease_id=$1",[newer]);
    expect((await service(db,"select fn_norma_checkpoint_recording($1,1::smallint,'call-1',1::smallint,$2,'reported_available') saved",[call.request_id,call.lease_id])).rows[0].saved).toBe(false);
    await service(db,"select fn_norma_finish_recording_lookup($1,false)",[call.lease_id]);
    expect((await db.query("select lease_id from norma_recording_lookup_control")).rows[0].lease_id).toBe(newer);
  }));
  it("terminalizes a crashed final lookup after its individual lease expires",()=>fixture(async(db,ids)=>{
    await request(db,ids);await seed(db);await enable(db);
    await db.query("update norma_attempt_recordings set lookup_attempts=6,next_lookup_at=now()-interval '1 minute'");
    expect((await claim(db)).rows).toHaveLength(0);
    expect((await db.query("select state from norma_attempt_recordings")).rows[0].state).toBe("failed");
  }));
  it("bounds historical seeding to 100 and claims to five without losing later identities",()=>fixture(async(db,ids)=>{
    for(let i=0;i<102;i++) {
      const property=randomUUID();
      await db.query("insert into properties(id,org_id,address,state,status) values($1,$2,'Batch fixture','MO','new_lead')",[property,ids.org]);
      await request(db,{...ids,property},`call-${i}`);
    }
    expect((await seed(db)).rows[0].n).toBe(100);
    expect((await seed(db)).rows[0].n).toBe(2);
    await enable(db);expect((await claim(db)).rows).toHaveLength(5);
    expect((await claim(db)).rows).toHaveLength(0);
    expect((await db.query("select count(*)::int n from norma_attempt_recordings where lookup_attempts=0")).rows[0].n).toBe(97);
  }));

  it("stops globally on a late denial even if another lease replaced the worker",()=>fixture(async(db,ids)=>{
    await request(db,ids);await enable(db);const call=(await claim(db)).rows[0];const newer=randomUUID();
    await db.query("update norma_recording_lookup_control set lease_id=$1",[newer]);
    await service(db,"select fn_norma_finish_recording_lookup($1,true)",[call.lease_id]);
    expect((await db.query("select enabled,lease_id from norma_recording_lookup_control")).rows[0]).toEqual({enabled:false,lease_id:newer});
    expect((await claim(db)).rows).toHaveLength(0);
  }));
  it("fails closed across lease expiry when a provider result or denial cannot be checkpointed",()=>fixture(async(db,ids)=>{
    await request(db,ids);await enable(db);const call=(await claim(db)).rows[0];
    expect((await service(db,"select fn_norma_start_recording_lookup($1) started",[call.lease_id])).rows[0].started).toBe(true);
    // Simulate a lost finish/checkpoint RPC after the provider response. No DB write arrives.
    await db.query("update norma_recording_lookup_control set lease_until=now()-interval '1 minute'");
    await db.query("update norma_attempt_recordings set next_lookup_at=now()-interval '1 minute'");
    expect((await claim(db)).rows).toHaveLength(0);
    expect((await db.query("select awaiting_result from norma_recording_lookup_control")).rows[0].awaiting_result).toBe(true);
  }));
  it("clears the write-ahead barrier only after a committed matching result",()=>fixture(async(db,ids)=>{
    await request(db,ids);await enable(db);const call=(await claim(db)).rows[0];
    await service(db,"select fn_norma_start_recording_lookup($1)",[call.lease_id]);
    await service(db,"select fn_norma_checkpoint_recording($1,1::smallint,'call-1',1::smallint,$2,'pending')",[call.request_id,call.lease_id]);
    expect((await db.query("select awaiting_result from norma_recording_lookup_control")).rows[0].awaiting_result).toBe(false);
  }));
  it("does not let conflicting provider identities across retry/current columns starve newer requests",()=>fixture(async(db,ids)=>{
    const makeProperty=async()=>{const id=randomUUID();await db.query("insert into properties(id,org_id,address,state,status) values($1,$2,'Conflict fixture','MO','new_lead')",[id,ids.org]);return id;};
    for(let i=0;i<101;i++) {
      const id=await request(db,{...ids,property:await makeProperty()},`existing-${i}`);
      await service(db,"select fn_norma_claim_dispatch($1,1)",[id]);
      expect((await service(db,"select fn_norma_complete_call($1,$2,'no_answer','{\"attempt\":1}'::jsonb) result",[id,`existing-${i}`])).rows[0].result).toMatchObject({retry:true});
    }
    await seed(db);await seed(db);
    for(let i=0;i<101;i++) await request(db,{...ids,property:await makeProperty()},`existing-${i}`);
    const fresh=await request(db,{...ids,property:await makeProperty()},"fresh");
    expect((await seed(db)).rows[0].n).toBe(1);
    expect((await db.query("select provider_call_id from norma_attempt_recordings where request_id=$1",[fresh])).rows[0].provider_call_id).toBe("fresh");
  }));

  it("restores the prior auth claim after service calls",()=>fixture(async(db,ids)=>{
    const previous=(await db.query("select coalesce(auth.role(),'') value")).rows[0].value;
    await request(db,ids);await seed(db);
    expect((await db.query("select coalesce(auth.role(),'') value")).rows[0].value).toBe(previous);
    await member(db,ids.user);
    expect((await db.query("select auth.role() value")).rows[0].value).toBe("authenticated");
  }));
  it("seeds one owner for an unledgered duplicate within a batch and advances later work",()=>fixture(async(db,ids)=>{
    const first=await request(db,ids,"duplicate");
    await service(db,"select fn_norma_claim_dispatch($1,1)",[first]);
    expect((await service(db,"select fn_norma_complete_call($1,'duplicate','no_answer','{\"attempt\":1}'::jsonb) result",[first])).rows[0].result).toMatchObject({retry:true});
    const makeProperty=async()=>{const id=randomUUID();await db.query("insert into properties(id,org_id,address,state,status) values($1,$2,'Batch fixture','MO','new_lead')",[id,ids.org]);return id;};
    await request(db,{...ids,property:await makeProperty()},"duplicate");
    expect((await seed(db)).rows[0].n).toBe(1);expect((await seed(db)).rows[0].n).toBe(0);
    const fresh=await request(db,{...ids,property:await makeProperty()},"new-call");
    expect((await seed(db)).rows[0].n).toBe(1);
    expect((await db.query("select provider_call_id from norma_attempt_recordings where request_id=$1",[fresh])).rows[0].provider_call_id).toBe("new-call");
  }));

});
