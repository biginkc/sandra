import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';

const sql=readFileSync(new URL('./20260929235000_my_leads_drip_scope.sql',import.meta.url),'utf8');
const url=process.env.TEST_SUPABASE_DB_URL??loadTestEnv().TEST_SUPABASE_DB_URL;

it('keeps a reply flag until a human text, logged attempt, or outcome, while opening has no effect',async()=>{
  if(!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  const target=new URL(url);
  if(target.hostname!=='127.0.0.1'||target.port!=='54329') throw new Error('Drip scope integration requires local Postgres at 127.0.0.1:54329');
  if(!/^begin;\s*/i.test(sql)||!/\s*commit;\s*$/i.test(sql)) throw new Error('Migration transaction wrapper changed');
  const db=new Client({connectionString:url});
  await db.connect();
  try {
    await db.query('begin');
    await db.query(sql.replace(/^begin;\s*/i,'').replace(/\s*commit;\s*$/i,''));
    const org=randomUUID(), rep=randomUUID(), sequence=randomUUID();
    await db.query('insert into auth.users(id) values ($1)',[rep]);
    await db.query("insert into public.organizations(id,name) values ($1,'Drip scope')",[org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')",[rep,org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[rep]);
    await db.query("select set_config('my_leads.designation_update',$1,true)",[`${rep}:${org}:${rep}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2',[rep,org]);
    await db.query("select set_config('my_leads.designation_update','',true)");
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)',[org]);
    await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Follow-up')",[sequence,org]);
    const step=randomUUID();
    await db.query("insert into public.sequence_steps(id,sequence_id,step_index,action_type,template_body) values ($1,$2,0,'send_sms','Follow up')",[step,sequence]);
    const ids=Object.fromEntries(['active','activeWithNewerCompleted','open','sms','ai','attempt','outcome','command','loggedAttempt','takeover','completed','resumed','otherEnrollment'].map(key=>[key,randomUUID()]));
    for(const [key,id] of Object.entries(ids)) {
      await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4)",[id,org,`${key} Main`,rep]);
      const status=['active','activeWithNewerCompleted','completed'].includes(key)?'active':'paused';
      const pauseReason=status==='paused'?(key==='takeover'?'rep_sms_human_takeover':'inbound_reply'):null;
      const enrollment=(await db.query("insert into public.sequence_enrollments(org_id,sequence_id,property_id,status,pause_reason,enrolled_at) values ($1,$2,$3,$4,$5,'2026-09-02T00:00:00Z') returning id",
        [org,sequence,id,status,pauseReason])).rows[0].id;
      const drip=(await db.query("insert into public.messages(org_id,property_id,channel,direction,body,status,created_at) values ($1,$2,'sms','outbound','Drip text','sent','2026-09-02T01:00:00Z') returning id",[org,id])).rows[0].id;
      await db.query("insert into public.sequence_step_runs(enrollment_id,step_id,message_id,scheduled_for) values ($1,$2,$3,'2026-09-02T01:00:00Z')",[enrollment,step,drip]);
      if(key==='completed') await db.query("update public.sequence_enrollments set status='completed',completed_at='2026-09-02T02:00:00Z' where id=$1",[enrollment]);
      if(key!=='active'&&key!=='activeWithNewerCompleted') await db.query("insert into public.messages(org_id,property_id,channel,direction,body,status,created_at) values ($1,$2,'sms','inbound','Reply','received','2026-09-03T00:00:00Z')",[org,id]);
      if(key==='resumed') await db.query("update public.sequence_enrollments set status='active',pause_reason=null where id=$1",[enrollment]);
      if(key==='otherEnrollment') {
        await db.query("insert into public.sequence_enrollments(org_id,sequence_id,property_id,status,enrolled_at) values ($1,$2,$3,'completed','2026-09-04T00:00:00Z')",[org,sequence,id]);
      }
      if(key==='activeWithNewerCompleted') {
        await db.query("insert into public.sequence_enrollments(org_id,sequence_id,property_id,status,enrolled_at) values ($1,$2,$3,'completed','2026-09-04T00:00:00Z')",[org,sequence,id]);
      }
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
    expect(before.get(ids.activeWithNewerCompleted).in_drip).toBe(true);
    expect(before.get(ids.activeWithNewerCompleted).replied_at).toBeNull();
    expect(before.get(ids.open).replied_at).toBeTruthy();
    expect(before.get(ids.takeover).replied_at).toBeTruthy();
    expect(before.get(ids.completed).replied_at).toBeTruthy();
    expect(before.get(ids.resumed).in_drip).toBe(true);
    expect(before.get(ids.resumed).replied_at).toBeNull();
    expect(before.get(ids.otherEnrollment).replied_at).toBeTruthy();
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
    const openEpisode=await db.query('select id from public.acquisition_assignment_episodes where org_id=$1 and property_id=$2 and ended_at is null',[org,ids.open]);
    expect(openEpisode.rows).toHaveLength(1);
    const commandKey=randomUUID();
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[rep]);
    const args=[org,rep,ids.open,openEpisode.rows[0].id,0,'new_lead',commandKey];
    const saved=await db.query('select public.fn_handoff_acquisition_lead_to_drip($1,$2,$3,$4,$5,$6,$7) as result',args);
    expect(saved.rows[0].result.ok).toBe(true);
    expect((await db.query('select public.fn_handoff_acquisition_lead_to_drip($1,$2,$3,$4,$5,$6,$7) as result',args)).rows[0].result).toEqual({...saved.rows[0].result,duplicate:true});
    await db.query('reset role');
    expect((await db.query('select outreach_dispo from public.properties where id=$1',[ids.open])).rows[0].outreach_dispo).toBe('needs_sequence');
    expect((await db.query('select version from public.acquisition_queue_states where property_id=$1',[ids.open])).rows[0].version).toBe('1');
    // The old queue read must lose when reassignment commits before its write.
    const prior=await db.query('select e.id as episode_id,coalesce(q.version,0) as queue_version from public.acquisition_assignment_episodes e left join public.acquisition_queue_states q on q.org_id=e.org_id and q.property_id=e.property_id where e.org_id=$1 and e.property_id=$2 and e.ended_at is null',[org,ids.active]);
    expect(prior.rows).toHaveLength(1);
    const nextRep=randomUUID();
    await db.query('insert into auth.users(id) values ($1)',[nextRep]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')",[nextRep,org]);
    await db.query("select set_config('my_leads.designation_update',$1,true)",[`${rep}:${org}:${nextRep}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2',[nextRep,org]);
    await db.query("select set_config('my_leads.designation_update','',true)");
    await db.query('update public.properties set assigned_user_id=$1 where id=$2 and org_id=$3',[nextRep,ids.active,org]);
    await db.query('savepoint stale_handoff');
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[rep]);
    await expect(db.query('select public.fn_handoff_acquisition_lead_to_drip($1,$2,$3,$4,$5,$6,$7)',
      [org,rep,ids.active,prior.rows[0].episode_id,prior.rows[0].queue_version,'new_lead',randomUUID()])).rejects.toThrow(/STALE_ASSIGNMENT/);
    await db.query('rollback to savepoint stale_handoff');
    await db.query('reset role');
    const unchanged=await db.query('select assigned_user_id,outreach_dispo from public.properties where id=$1',[ids.active]);
    expect(unchanged.rows[0]).toMatchObject({assigned_user_id:nextRep,outreach_dispo:null});
  } finally {await db.query('rollback').catch(()=>{});await db.end();}
});
