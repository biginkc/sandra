import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';

const sql=readFileSync(new URL('./20260929235000_my_leads_drip_scope.sql',import.meta.url),'utf8');
const url=process.env.TEST_SUPABASE_DB_URL??loadTestEnv().TEST_SUPABASE_DB_URL;

it('keeps a reply flag until a human text, logged attempt, or outcome, while opening has no effect',async()=>{
  if(!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  const db=new Client({connectionString:url});
  await db.connect();
  try {
    await db.query(sql);
    await db.query('begin');
    const org=randomUUID(), rep=randomUUID(), sequence=randomUUID();
    await db.query('insert into auth.users(id) values ($1)',[rep]);
    await db.query("insert into public.organizations(id,name) values ($1,'Drip scope')",[org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')",[rep,org]);
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)',[org]);
    await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Follow-up')",[sequence,org]);
    const ids=Object.fromEntries(['active','open','sms','ai','attempt','outcome','command','loggedAttempt'].map(key=>[key,randomUUID()]));
    for(const [key,id] of Object.entries(ids)) {
      await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4)",[id,org,`${key} Main`,rep]);
      await db.query("insert into public.sequence_enrollments(org_id,sequence_id,property_id,status,pause_reason,enrolled_at) values ($1,$2,$3,$4,$5,'2026-09-02T00:00:00Z')",
        [org,sequence,id,key==='active'?'active':'paused',key==='active'?null:'inbound_reply']);
      if(key!=='active') await db.query("insert into public.messages(org_id,property_id,channel,direction,body,status,created_at) values ($1,$2,'sms','inbound','Reply','received','2026-09-03T00:00:00Z')",[org,id]);
    }
    const read=async()=>{
      await db.query('set local role authenticated');
      await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[rep]);
      const result=await db.query('select * from public.fn_list_my_leads_drip_scope($1,$2)',[org,rep]);
      await db.query('reset role');
      return new Map(result.rows.map(row=>[row.property_id,row]));
    };
    const before=await read();
    expect(before.get(ids.active).in_drip).toBe(true);
    expect(before.get(ids.open).replied_at).toBeTruthy();
    // Reading/opening the lead writes no action and therefore leaves the flag.
    expect((await read()).get(ids.open).replied_at).toBeTruthy();
    await db.query("insert into public.messages(org_id,property_id,channel,direction,body,status,created_at) values ($1,$2,'sms','outbound','Human reply','sent','2026-09-04T00:00:00Z')",[org,ids.sms]);
    await db.query("insert into public.messages(org_id,property_id,channel,direction,body,status,metadata,created_at) values ($1,$2,'sms','outbound','AI reply','sent','{\"generated_by\":\"ai_responder_v1\"}','2026-09-04T00:00:00Z')",[org,ids.ai]);
    await db.query("insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,recorded_at,idempotency_key) values ($1,$2,$3,'outreach','manual','reached','2026-09-04T00:00:00Z','2026-09-04T00:00:00Z',$4)",[org,ids.attempt,rep,randomUUID()]);
    await db.query("insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,created_at) values ($1,$2,'user',$3,'dispo_set','2026-09-04T00:00:00Z')",[org,ids.outcome,rep]);
    for(const [key,operation] of [['command','ready_acquisition_offer'],['loggedAttempt','log_acquisition_attempt']]) {
      await db.query("insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,created_at) values ($1,$2,'user',$3,'my_leads_workflow',jsonb_build_object('operation',$4::text),'2026-09-04T00:00:00Z')",[org,ids[key],rep,operation]);
    }
    const after=await read();
    for(const key of ['sms','attempt','outcome','command','loggedAttempt']) expect(after.get(ids[key]).replied_at).toBeNull();
    expect(after.get(ids.ai).replied_at).toBeTruthy();
    expect(after.get(ids.open).replied_at).toBeTruthy();
  } finally {await db.query('rollback').catch(()=>{});await db.end();}
});
