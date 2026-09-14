/** PREPARED ONLY. Run explicitly with --apply-owned-local. Never targets hosted data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const config={host:'127.0.0.1',port:58322,user:'postgres',password:'postgres',database:'postgres'};
const org='00000000-0000-0000-0000-000000000bbb';
const rep='10000000-0000-4000-8000-000000000003';
const principals=['002','003','013','014'].map(x=>`10000000-0000-4000-8000-000000000${x}`).sort();
const stages=['not_contacted','contacted','needs_offer','offer_sent','under_contract'];
const propertyId=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const contactId=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const manifest=stages.flatMap((stage,s)=>Array.from({length:21},(_,i)=>({id:propertyId(1000+s*21+i),contactId:contactId(1000+s*21+i),stage,address:`Stress ${stage} ${String(i+1).padStart(2,'0')} Fixture Lane`,index:i})));
const detailId=propertyId(1021);
if(!process.argv.includes('--apply-owned-local')){
  console.log(JSON.stringify({status:'PLAN ONLY; no connection or mutation',count:105,perStage:21,detailId,detailCounts:{notes:60,attempts:60,offers:25,history:26},manifest},null,2));
  process.exit(0);
}
assert.equal(config.host,'127.0.0.1');assert.equal(config.port,58322);
const db=new pg.Client(config);await db.connect();
let transaction=false;
try{
  const identity=(await db.query('select current_database() name,inet_server_port() port')).rows[0];
  assert.equal(identity.name,'postgres'); // Docker maps host58322 to container5432.
  assert.deepEqual((await db.query('select id::text from auth.users order by id')).rows.map(x=>x.id),principals);
  assert.equal((await db.query("select count(*)::int n from properties where id::text not like '20000000-0000-4000-8000-%' or address not like '%Fixture Lane'")).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from properties where id=any($1::uuid[])',[manifest.map(x=>x.id)])).rows[0].n,0,'Refuse rerun/overwrite: augmented IDs already exist');
  assert.equal((await db.query('select count(*)::int n from contacts where id=any($1::uuid[])',[manifest.map(x=>x.contactId)])).rows[0].n,0);
  const settings=(await db.query('select my_leads_enabled from acquisition_org_settings where org_id=$1',[org])).rows[0];assert.equal(settings?.my_leads_enabled,true);
  assert.equal((await db.query('select acquisitions_enabled from memberships where org_id=$1 and user_id=$2',[org,rep])).rows[0]?.acquisitions_enabled,true);
  const before=(await db.query('select (select count(*) from tasks)::int tasks,(select count(*) from sequence_enrollments)::int enrollments,(select count(*) from esign_requests)::int esign')).rows[0];
  await db.query('begin');transaction=true;
  const anchor=(await db.query('select statement_timestamp() now')).rows[0].now;
  const at=minutes=>new Date(anchor.getTime()+minutes*60000).toISOString();
  // Use native assignment observer and workflow RPCs for queue state. Historical
  // paging-only facts below are explicit synthetic SQL fixtures, not UI evidence.
  async function command(fn,id,fields){
    assert.ok(['fn_log_acquisition_attempt','fn_ready_acquisition_offer','fn_log_acquisition_offer','fn_record_acquisition_contract'].includes(fn));
    const row=(await db.query('select p.status,e.id episode,coalesce(q.version,0)::int version from properties p join acquisition_assignment_episodes e on e.property_id=p.id and e.ended_at is null left join acquisition_queue_states q on q.property_id=p.id where p.id=$1',[id])).rows[0];
    const input={orgId:org,propertyId:id,expectedEpisodeId:row.episode,expectedQueueVersion:row.version,expectedSharedStatus:row.status,idempotencyKey:randomUUID(),...fields};
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[rep]);await db.query('set local role authenticated');
    const result=(await db.query(`select public.${fn}($1::jsonb) result`,[JSON.stringify(input)])).rows[0].result;
    await db.query('reset role');assert.equal(result.ok,true,JSON.stringify(result));
  }
  for(const fixture of manifest){
    await db.query("insert into contacts(id,org_id,first_name,last_name) values($1,$2,'Stress',$3)",[fixture.contactId,org,fixture.address]); // No phone or email: impossible provider destination.
    await db.query("insert into properties(id,org_id,address,state,assigned_user_id,homeowner_contact_id) values($1,$2,$3,'MO',$4,$5)",[fixture.id,org,fixture.address,rep,fixture.contactId]);
    // Stable synthetic working-time scenarios use a fixed Friday inside Central hours.
    const assigned=fixture.index%3===0?'2026-09-11T21:45:00Z':fixture.index%3===1?'2026-09-11T13:45:00Z':'2026-09-11T22:15:00Z';
    await db.query('update acquisition_assignment_episodes set assigned_at=$2 where property_id=$1 and ended_at is null',[fixture.id,assigned]);
    if(fixture.stage==='contacted')await command('fn_log_acquisition_attempt',fixture.id,{source:'manual',kind:'outreach',outcome:'no_answer',occurredAt:at(-60)});
    if(fixture.stage==='needs_offer'){
      await command('fn_ready_acquisition_offer',fixture.id,{motivationResponse:{kind:'no_motivation',text:null}});
      // Alternating clear/overdue at captured anchor; not a claim of exact boundary proof.
      await db.query('update acquisition_queue_states set stage_entered_at=$2 where property_id=$1',[fixture.id,at(fixture.index%2===0?-780:-660)]);
    }
    if(fixture.stage==='offer_sent')await command('fn_log_acquisition_offer',fixture.id,{motivationResponse:{kind:'no_motivation',text:null},amountCents:10000000+fixture.index,sentAt:at(-120),followUpAt:at(fixture.index%2===0?-60:60),method:'verbal'});
    if(fixture.stage==='under_contract')await command('fn_record_acquisition_contract',fixture.id,{signedAt:at(-30),offerId:null});
  }
  // The dedicated Contacted lead already has one native attempt. Add59, total60.
  const episode=(await db.query('select id from acquisition_assignment_episodes where property_id=$1 and ended_at is null',[detailId])).rows[0].id;
  for(let i=0;i<60;i++)await db.query('insert into lead_notes(org_id,property_id,author_user_id,body,created_at) values($1,$2,$3,$4,$5)',[org,detailId,rep,`Synthetic pagination note ${String(i+1).padStart(2,'0')}`,at(-100-i)]);
  for(let i=0;i<59;i++)await db.query("insert into acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,outcome,occurred_at,idempotency_key) values($1,$2,$3,$4,'outreach','manual','no_answer',$5,$6)",[org,detailId,episode,rep,at(-100-i),randomUUID()]);
  // Resolved synthetic offers avoid the single-pending-offer uniqueness fence.
  // Historic facts deliberately do not invoke decline/handoff current-state effects.
  for(let i=0;i<25;i++)await db.query("insert into acquisition_offers(org_id,property_id,assignment_episode_id,actor_user_id,amount_cents,sent_via,sent_at,follow_up_at,outcome,outcome_at,outcome_by,idempotency_key) values($1,$2,$3,$4,$5,'verbal',$6,$7,'declined',$8,$4,$9)",[org,detailId,episode,rep,10000000+i,at(-300-i*3),at(-298-i*3),at(-299-i*3),randomUUID()]);
  // History is assignment episodes, not note/event history.25closed+1open.
  for(let i=0;i<25;i++)await db.query("insert into acquisition_assignment_episodes(org_id,property_id,assignee_user_id,episode_kind,eligible,assigned_at,initialized_at,ended_at) values($1,$2,$3,'live',false,$4,$4,$5)",[org,detailId,rep,new Date(Date.parse('2026-08-01T14:00:00Z')+i*86400000).toISOString(),new Date(Date.parse('2026-08-01T15:00:00Z')+i*86400000).toISOString()]);
  const after=(await db.query('select (select count(*) from tasks)::int tasks,(select count(*) from sequence_enrollments)::int enrollments,(select count(*) from esign_requests)::int esign')).rows[0];assert.deepEqual(after,before);
  assert.equal((await db.query('select count(*)::int n from auth.users')).rows[0].n,4);
  const counts=(await db.query("select coalesce(q.stage,'not_contacted') stage,count(*)::int n from properties p left join acquisition_queue_states q on q.property_id=p.id where p.id=any($1::uuid[]) group by 1",[manifest.map(x=>x.id)])).rows;
  assert.equal(counts.length,5);assert.ok(counts.every(x=>x.n===21));
  const detailCounts=(await db.query('select (select count(*) from lead_notes where property_id=$1)::int notes,(select count(*) from acquisition_attempts where property_id=$1)::int attempts,(select count(*) from acquisition_offers where property_id=$1)::int offers,(select count(*) from acquisition_assignment_episodes where property_id=$1)::int history',[detailId])).rows[0];
  assert.deepEqual(detailCounts,{notes:60,attempts:60,offers:25,history:26});
  await db.query('commit');transaction=false;
  console.log(JSON.stringify({status:'SEEDED LOCAL FIXTURES; not test passes',anchor,counts,detailId,detailCounts,sideEffectsUnchanged:after,manifest},null,2));
}catch(error){if(transaction)await db.query('rollback');throw error;}finally{await db.end();}
