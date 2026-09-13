/** Synthetic local-only behavior proof; all fixture writes roll back.
 * node --conditions=react-server --import tsx scripts/rehearse-dialpad-full-schema-behavior.mjs
 */
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import pg from 'pg';
import webhookAuth from '../src/lib/dialpad-voice/webhook-auth.ts';
const {verifyDialpadVoiceEvent}=webhookAuth;
const dir=process.argv[2]??'/tmp/sandra-dialpad-full-schema-Dp6VHR';
assert.match(dir,/^\/tmp\/sandra-dialpad-full-schema-[A-Za-z0-9]+$/);
assert.equal(existsSync(dir+'/supabase/.temp/project-ref'),false);
const config=readFileSync(dir+'/supabase/config.toml','utf8');
const port=Number(config.match(/\[db\]\s*[\s\S]*?^port = (\d+)/m)?.[1]);
assert.ok(port>=59000&&port<60000);
const client=new pg.Client({host:'127.0.0.1',port,user:'postgres',password:'postgres',database:'postgres'});
const receipt={scope:'Genuine local full-schema synthetic behavior; rollback only',checks:[],failure:null};
let step='connect';
try {
 await client.connect();await client.query('begin');
 const org=randomUUID(),foreign=randomUUID(),rep=randomUUID(),owner=randomUUID(),contact=randomUUID(),lead=randomUUID(),intent=randomUUID();
 step='real constraints seed';
 await client.query("insert into organizations(id,name) values($1,$3),($2,$4)",[org,foreign,'Dialpad local fixture '+org,'Dialpad foreign fixture '+foreign]);
 await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",[rep,'dialpad-'+rep+'@example.invalid',{fixture_owner:'dialpad-full-schema-local'}]);
 await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",[owner,'dialpad-owner-'+owner+'@example.invalid',{fixture_owner:'dialpad-full-schema-local'}]);
 await client.query("insert into memberships(org_id,user_id,role) values($1,$2,'owner')",[org,owner]);
 await client.query("insert into memberships(org_id,user_id,role) values($1,$2,'member')",[org,rep]);
 await client.query('insert into acquisition_org_settings(org_id,my_leads_enabled) values($1,true)',[org]);
 await client.query("insert into contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values($1,$2,'Dialpad local','Fixture','+12025550101','mobile')",[contact,org]);
 await client.query("insert into properties(id,org_id,address,state,assigned_user_id,homeowner_contact_id,status) values($1,$2,'1 Dialpad Local Fixture Lane','MO',$3,$4,'new_lead')",[lead,org,rep,contact]);
 const episode=(await client.query('select id from acquisition_assignment_episodes where property_id=$1 and ended_at is null',[lead])).rows[0]?.id;assert.ok(episode);
 const hash=createHash('sha256').update(intent).digest('hex');
 await client.query('select fn_bind_acquisition_call_context($1,$2,$3,$4)',[org,lead,rep,hash]);
 await client.query("insert into dialpad_voice_intents(id,org_id,actor_user_id,property_id,assignment_episode_id,binding_token_hash,dialpad_user_id,destination_e164,caller_id_e164,client_idempotency_key) values($1,$2,$3,$4,$5,$6,'4904023124647936','+12025550101','+12025550102',$1)",[intent,org,rep,lead,episode,hash]);
 receipt.checks.push('real org/user/membership/contact/lead/assignment/intent constraints');
 const now=Date.now(),body={call_id:'9007199254740993',state:'calling',custom_data:intent,direction:'outbound',target:{id:'4904023124647936',type:'User'},internal_number:'+12025550102',external_number:'+12025550101',date_started:now,event_timestamp:now};
 const secret=randomUUID();
 const store=async(payload,scope=org)=>{
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),data=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signed=header+'.'+data+'.'+createHmac('sha256',secret).update(header+'.'+data).digest('base64url');
  const verified=verifyDialpadVoiceEvent(signed,secret);assert.deepEqual(verified,payload);assert.equal(verifyDialpadVoiceEvent(signed,'wrong'),null);
  const id=randomUUID();await client.query('insert into dialpad_voice_event_inbox(id,org_id,envelope_sha256,payload) values($1,$2,$3,$4)',[id,scope,createHash('sha256').update(signed).digest('hex'),verified]);return id;
 };
 const apply=async(id)=>{await client.query('set local role service_role');try{return(await client.query('select fn_record_dialpad_acquisition_call_start($1,$2) result',[intent,id])).rows[0].result;}finally{await client.query('reset role');}};
 step='signed start and duplicate';const started=await store(body);const first=await apply(started);assert.equal(first.tracked,true);assert.equal((await apply(started)).duplicate,true);
 receipt.checks.push('actual HS256 verifier rejects wrong secret; stored digest/verified payload drives RPC; duplicate is idempotent');
 step='terminal enrichment';const ended=await store({...body,state:'hangup',date_ended:now+71000,event_timestamp:now+71000,duration:71000,was_recorded:true});await apply(ended);await apply(started);
 const activity=(await client.query('select * from call_activities where id=$1',[first.callActivityId])).rows[0];assert.equal(activity.provider_ended_at.getTime(),now+71000);assert.equal(activity.recording_expected,true);assert.equal(activity.duration_seconds,71);
 receipt.checks.push('terminal enriches authoritative end/duration/recording expectation; reordered start does not erase end');
 step='representative wrap';await client.query("select set_config('request.jwt.claim.sub',$1,true)",[rep]);await client.query('set local role authenticated');
 const wrap={orgId:org,propertyId:lead,source:'dialpad',callActivityId:first.callActivityId,idempotencyKey:randomUUID(),outcome:'reached'};
 await client.query('select fn_finalize_acquisition_attempt($1)',[wrap]);await client.query('select fn_finalize_acquisition_attempt($1)',[wrap]);await client.query('reset role');await apply(ended);
 const attempts=(await client.query('select outcome,actor_user_id from acquisition_attempts where org_id=$1',[org])).rows;assert.equal(attempts.length,1);assert.equal(attempts[0].outcome,'reached');assert.equal(attempts[0].actor_user_id,rep);
 receipt.checks.push('rep-selected wrap repeated twice plus replay leaves one attempt and immutable actor');
 step='wrong org receipt';const bad=await store({...body,event_timestamp:now+1},foreign);await client.query('savepoint bad_org');await client.query('set local role service_role');
 await assert.rejects(client.query('select fn_record_dialpad_acquisition_call_start($1,$2)',[intent,bad]),/DIALPAD/);await client.query('rollback to savepoint bad_org');await client.query('reset role');
 assert.equal((await client.query('select count(*)::int n from acquisition_attempts where org_id=$1',[foreign])).rows[0].n,0);receipt.checks.push('wrong-org receipt rejected with zero foreign credit');
 console.log('PASS: '+receipt.checks.length+' full-schema behavior checks');
}catch(error){receipt.failure={step,code:error.code??null,message:error.message};console.error(JSON.stringify(receipt.failure));process.exitCode=1;}
finally{await client.query('rollback');await client.end();writeFileSync(dir+'/behavior-receipt.json',JSON.stringify(receipt,null,2),{mode:0o600});}
