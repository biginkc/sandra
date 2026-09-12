/** Reproducible, explicitly destructive ONLY to this task's dedicated local fixture stack. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const root=fileURLToPath(new URL('..',import.meta.url));
const dir='/tmp/sandra-my-leads-acceptance-20260911/';
const socket='unix:///Users/jarradhenry/.colima/sandra-my-leads-20260911/docker.sock';
const baseline='8c7053e7024433f46791eac1b186c1b7a7cf10ec';
// Match Sandra's existing organization gate within this isolated local database.
const org='00000000-0000-0000-0000-000000000bbb', other='10000000-0000-4000-8000-000000000012';
const owner='10000000-0000-4000-8000-000000000002', rep='10000000-0000-4000-8000-000000000003';
const foreign='10000000-0000-4000-8000-000000000013', foreignOwner='10000000-0000-4000-8000-000000000014';
const connect=async()=>{const c=new pg.Client({host:'127.0.0.1',port:58322,user:'postgres',password:'postgres',database:'postgres'});await c.connect();return c;};
const identities=JSON.parse(readFileSync(dir+'identities.json','utf8'));
assert.deepEqual(identities.map(x=>x.id).sort(),[owner,rep,foreign,foreignOwner].sort());
if(!process.argv.includes('--reset-owned-local'))throw new Error('Requires --reset-owned-local; this resets only the dedicated local acceptance stack.');
assert.equal(existsSync(dir+'supabase/.temp/project-ref'),false,'A linked hosted project is forbidden');
const env={...process.env,DOCKER_HOST:socket};
const containers=execFileSync('docker',['ps','--format','{{.Names}}'],{env,encoding:'utf8'}).trim().split('\n');
assert.ok(containers.includes('supabase_db_sandra-my-leads-acceptance-20260911'));
assert.ok(containers.every(n=>n.endsWith('_sandra-my-leads-acceptance-20260911')),'Unexpected container in the owned runtime');
let db=await connect();
try{
 const users=(await db.query('select id from auth.users')).rows;
 assert.ok(users.every(u=>identities.some(i=>i.id===u.id)),'Unexpected principal: refuse reset');
 const hasProperties=(await db.query("select to_regclass('public.properties') exists")).rows[0].exists;
 if(hasProperties){const unknown=(await db.query("select count(*)::int n from public.properties where id::text not like '20000000-0000-4000-8000-%' or address not like '%Fixture Lane'")).rows[0].n;assert.equal(unknown,0,'Unexpected property: refuse reset');}
}finally{await db.end();}
writeFileSync(dir+'reset.log','',{mode:0o600});
try{const out=execFileSync('supabase',['db','reset','--local','--no-seed','--workdir',dir],{env,encoding:'utf8',maxBuffer:8*1024*1024});writeFileSync(dir+'reset.log',out,{mode:0o600});}
catch(e){writeFileSync(dir+'reset.log',String(e.stdout??'')+String(e.stderr??''),{mode:0o600});throw new Error('Owned local reset failed; inspect the protected local log.');}
const runtime=JSON.parse(execFileSync('supabase',['status','--workdir',dir,'--output','json'],{env,encoding:'utf8',stdio:['ignore','pipe','ignore']}));
assert.equal(runtime.API_URL,'http://127.0.0.1:58321');
writeFileSync(dir+'runtime.json',JSON.stringify(runtime),{mode:0o600});
const admin=createClient(runtime.API_URL,runtime.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const receipt={baseline,baselineMigrations:[],featureMigrations:[],checks:[],failure:null};
db=await connect();
let step='baseline';
const hash=s=>createHash('sha256').update(s).digest('hex');
const propertyId=i=>`20000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
async function seedProperty(i,orgId,assignee){
 const contact=`30000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
 await db.query("insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values($1,$2,$3,'Fixture',$4,'mobile')",[contact,orgId,`Lead ${i}`,`+120255501${String(i).padStart(2,'0')}`]);
 await db.query("insert into public.properties(id,org_id,assigned_user_id,address,state,homeowner_contact_id) values($1,$2,$3,$4,'MO',$5)",[propertyId(i),orgId,assignee,i===9?'109 Foreign Fixture Lane':`${100+i} My Leads Fixture Lane`,contact]);
}
try{
 const files=execFileSync('git',['ls-tree','-r','--name-only',baseline,'supabase/migrations'],{cwd:root,encoding:'utf8'}).split('\n').filter(f=>f.endsWith('.sql')).sort();
 for(const file of files){step=file;const sql=execFileSync('git',['show',`${baseline}:${file}`],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});await db.query(sql);receipt.baselineMigrations.push({file,sha256:hash(sql)});}
 step='fixed local principals';
 for(const u of identities){const result=await admin.auth.admin.createUser({id:u.id,email:u.email,password:u.password,email_confirm:true,user_metadata:{full_name:`My Leads ${u.role} fixture`,fixture_owner:'my-leads-20260911'}});if(result.error)throw result.error;assert.equal(result.data.user.id,u.id);}
 await db.query("insert into public.organizations(id,name) values($1,'My Leads local fixture A'),($2,'My Leads local fixture B') on conflict(id) do nothing",[org,other]);
 await db.query("insert into public.memberships(org_id,user_id,role) values($1,$3,'owner'),($2,$4,'owner')",[org,other,owner,foreignOwner]);
 await db.query("insert into public.memberships(org_id,user_id,role) values($1,$3,'member'),($2,$4,'member')",[org,other,rep,foreign]);
 step='genuine pre-feature lead';await seedProperty(8,org,rep);
 for(const file of readdirSync(root+'supabase/migrations').filter(f=>f.startsWith('20260912')&&f.endsWith('.sql')).sort()){
  step=file;const sql=readFileSync(root+'supabase/migrations/'+file,'utf8');await db.query(sql);receipt.featureMigrations.push({file,sha256:hash(sql)});
 }
 step='legacy launch';
 assert.equal((await db.query('select count(*)::int n from acquisition_assignment_episodes')).rows[0].n,0);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.query('set role authenticated');
 await db.query('select fn_set_acquisition_designation($1,$2,true,false,gen_random_uuid())',[org,rep]);
 await db.query('reset role');
 await db.query('insert into acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values($1,false,$2)',[org,owner]);
 await db.query('set role authenticated');
 const preview=(await db.query('select fn_preview_acquisition_launch($1,$2) result',[org,rep])).rows[0].result;
 assert.equal(preview.previewCount,1);assert.equal(preview.rows[0].expected_episode_id,null);
 const key=randomUUID();const args=[org,rep,preview.cohortId,preview.fingerprint,preview.settingsRevision,key];
 const applied=(await db.query('select fn_apply_acquisition_launch($1,$2,$3,$4,$5,$6) result',args)).rows[0].result;assert.equal(applied.ok,true);
 assert.equal((await db.query('select fn_apply_acquisition_launch($1,$2,$3,$4,$5,$6) result',args)).rows[0].result.duplicate,true);
 await db.query('reset role');
 const episode=(await db.query('select * from acquisition_assignment_episodes where property_id=$1',[propertyId(8)])).rows[0];
 assert.equal(episode.episode_kind,'launch');assert.equal(episode.assigned_at,null);assert.equal(episode.eligible,false);
 assert.equal((await db.query('select count(*)::int n from acquisition_attempts')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from acquisition_offers')).rows[0].n,0);
 receipt.checks.push('pre-feature lead with no episode: preview/apply/replay, no fictitious activity or clock');
 await db.query('update acquisition_org_settings set my_leads_enabled=true where org_id=$1',[org]);
 step='new fixture assignments';for(let i=1;i<=7;i++)await seedProperty(i,org,rep);await seedProperty(9,other,foreign);
 await db.query("notify pgrst,'reload schema'");
 step='authenticated API workflows';
 const repIdentity=identities.find(u=>u.id===rep);const api=createClient(runtime.API_URL,runtime.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const login=await api.auth.signInWithPassword({email:repIdentity.email,password:repIdentity.password});if(login.error)throw login.error;
 const queue=await api.rpc('fn_get_acquisition_queue_page',{p_org_id:org,p_member_id:rep});if(queue.error)throw queue.error;
 for(const [i,fn,fields] of [
  [2,'fn_log_acquisition_attempt',{source:'manual',kind:'outreach',outcome:'no_answer',occurredAt:new Date().toISOString()}],
  [3,'fn_ready_acquisition_offer',{motivationResponse:{kind:'no_motivation',text:null},temperature:'warm'}],
  [4,'fn_log_acquisition_offer',{motivationResponse:{kind:'specified',text:'Synthetic relocation'},temperature:'hot',amountCents:12500000,method:'verbal',sentAt:new Date().toISOString(),followUpAt:new Date(Date.now()+3600000).toISOString()}],
  [5,'fn_record_acquisition_contract',{signedAt:new Date().toISOString(),offerId:null}],
 ]){
  const row=queue.data.stages.not_contacted.rows.find(r=>r.propertyId===propertyId(i));assert.ok(row);
  const input={orgId:org,propertyId:row.propertyId,expectedEpisodeId:row.assignmentEpisodeId,expectedQueueVersion:row.queueVersion,expectedSharedStatus:row.sharedStatus,idempotencyKey:randomUUID(),...fields};
  const result=await api.rpc(fn,{p_input:input});if(result.error)throw result.error;assert.equal(result.data.ok,true);receipt.checks.push(`${fn}: ${result.data.stage}`);
 }
 await api.auth.signOut();receipt.checks.push('four fixed principals; nine synthetic leads; no provider credentials');
 console.log(`PASS: ${receipt.baselineMigrations.length} baseline + ${receipt.featureMigrations.length} feature migrations, legacy initialization and authenticated workflow fixtures`);
}catch(error){await db.query('rollback');receipt.failure={step,code:error.code??null,message:error.message};console.error(JSON.stringify(receipt.failure));process.exitCode=1;}
finally{await db.end();writeFileSync(dir+'full-schema-replay.json',JSON.stringify(receipt,null,2),{mode:0o600});}
