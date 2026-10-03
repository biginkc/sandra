import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';

const sql=readFileSync(new URL('./20261003130000_my_leads_conflicts_non_retryable.sql',import.meta.url),'utf8');
const url=process.env.TEST_SUPABASE_DB_URL??loadTestEnv().TEST_SUPABASE_DB_URL;

it('raises definite My Leads conflicts with a non-retryable SQLSTATE and keeps the message',async()=>{
  if(!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  const target=new URL(url);
  if(target.hostname!=='127.0.0.1'||target.port!=='54329') throw new Error('Requires local Postgres at 127.0.0.1:54329');
  if(!/^begin;\s*/i.test(sql)||!/\s*commit;\s*$/i.test(sql)) throw new Error('Migration transaction wrapper changed');
  const db=new Client({connectionString:url});
  await db.connect();
  try {
    await db.query('begin');
    // Includes the migration's own post-condition (no function still raises 40001).
    await db.query(sql.replace(/^begin;\s*/i,'').replace(/\s*commit;\s*$/i,''));
    const org=randomUUID(), owner=randomUUID(), rep=randomUUID(), property=randomUUID();
    for(const id of [owner,rep]) await db.query('insert into auth.users(id) values ($1)',[id]);
    await db.query("insert into public.organizations(id,name) values ($1,'Conflict codes')",[org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')",[owner,org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')",[rep,org]);
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)',[org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
    await db.query("select set_config('my_leads.designation_update',$1,true)",[`${owner}:${org}:${rep}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2',[rep,org]);
    await db.query("select set_config('my_leads.designation_update','',true)");
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,'1 Main','MO','new_lead',$3)",[property,org,rep]);
    const episode=(await db.query('select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null',[property])).rows[0].id;

    const asRep=async(fn:()=>Promise<unknown>)=>{
      await db.query('savepoint s');
      await db.query('set local role authenticated');
      await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[rep]);
      let failure:{code?:string;message?:string}|null=null;
      let value:unknown=null;
      try { value=await fn(); } catch(error) { failure=error as {code?:string;message?:string}; }
      await db.query('rollback to savepoint s');
      await db.query('reset role');
      return {failure,value};
    };
    const log=(overrides:Record<string,unknown>,key=randomUUID())=>
      db.query('select public.fn_log_acquisition_attempt($1::jsonb) as r',[JSON.stringify({
        propertyId:property,idempotencyKey:key,expectedEpisodeId:episode,expectedQueueVersion:0,expectedSharedStatus:'new_lead',
        occurredAt:new Date(Date.now()-60_000).toISOString(),source:'manual',kind:'outreach',outcome:'no_answer',...overrides})]);
    // Not a serialization failure class, and not retryable by PostgREST.
    const expectConflict=(result:{failure:{code?:string;message?:string}|null},message:string)=>{
      expect(result.failure?.message).toContain(message);
      expect(result.failure?.code).toBe('MLS01');
      expect(result.failure?.code?.startsWith('40')).toBe(false);
    };

    // Sanity: a fresh, correct save still succeeds.
    const ok=await asRep(()=>log({}));
    expect(ok.failure).toBeNull();

    // The production repro: a stale save (fn_log_acquisition_attempt).
    expectConflict(await asRep(()=>log({expectedQueueVersion:7})),'STALE_STATE');
    expectConflict(await asRep(()=>log({expectedSharedStatus:'contacted'})),'STALE_STATE');
    expectConflict(await asRep(()=>log({expectedEpisodeId:randomUUID()})),'STALE_ASSIGNMENT');
    // Same idempotency key replayed with a different payload.
    expectConflict(await asRep(async()=>{
      const key=randomUUID();
      await log({},key);
      return log({outcome:'reached'},key);
    }),'IDEMPOTENCY_CONFLICT');
    // Drip handoff stale checks.
    const handoff=(version:number,ep=episode)=>db.query('select public.fn_handoff_acquisition_lead_to_drip($1,$2,$3,$4,$5,$6,$7)',
      [org,rep,property,ep,version,'new_lead',randomUUID()]);
    expectConflict(await asRep(()=>handoff(9)),'STALE_STATE');
    expectConflict(await asRep(()=>handoff(0,randomUUID())),'STALE_ASSIGNMENT');

    // No My Leads function raises 40001 any more.
    const left=await db.query(`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like '%acquisition%' or p.proname like 'my_leads%') and p.prosrc like '%40001%'`);
    expect(left.rows).toEqual([]);
  } finally {await db.query('rollback').catch(()=>{});await db.end();}
});
