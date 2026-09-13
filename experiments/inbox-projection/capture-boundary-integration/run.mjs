import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReadBoundaryCodec } from '../../../src/lib/inbox/read-boundary.ts';

const here=fileURLToPath(new URL('.',import.meta.url));
function need(ok,message){if(ok!==true)throw new Error(message);}
need(process.argv.includes('--run-owned-fixture'),'Explicit root fixture grant required');
need(process.versions.node.startsWith('22.'),'Use approved Node22 runtime');
const guard=spawnSync('python3',[here+'guard.py'],{encoding:'utf8',timeout:30000});
need(guard.status===0,'Fixture guard refused: '+guard.stderr);
const docker=['--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock','exec','-i','sandra-inbox-projection-t2-db','psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
const prefix="SET statement_timeout='15s';SET lock_timeout='2s';";
function sql(query,allowedError=false){
 const r=spawnSync('docker',docker,{input:prefix+query,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
 if(!allowedError)need(r.status===0,'Fixture SQL failed: '+r.stderr);
 return allowedError?r:r.stdout.trim();
}
function denied(query,code,message){const r=sql(query,true);need(r.status!==0&&r.stderr.includes('ERROR:  '+code+':')&&r.stderr.includes(message),'Expected precise SQL refusal');}
const lit=(v)=>"'"+String(v).replaceAll("'","''")+"'";
const org=randomUUID(),otherOrg=randomUUID(),conv=randomUUID(),user=randomUUID(),other=randomUUID(),keeper=randomUUID();
function request({who=user,tenant=org,query}={}){
 const claims=JSON.stringify({sub:who,role:'authenticated'});
 return `BEGIN READ ONLY;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claims=${lit(claims)};${query??`SELECT inbox_t2_capture_boundary.detail('${tenant}','${conv}');`}ROLLBACK;`;
}
const detail=()=>JSON.parse(sql(request()));
const checks=[];
function pass(name){checks.push({name,passed:true});}
const underlyingBefore=sql("SELECT md5(pg_get_functiondef('inbox_t2_authenticated_detail.detail_v2(uuid,uuid,timestamptz,uuid)'::regprocedure));");
need(sql("SELECT count(*) FROM pg_namespace WHERE nspname='inbox_t2_capture_boundary';")==='0','Integration already installed; refusing before fixture writes');
need(sql("SELECT provolatile='s' AND prosecdef AND pg_get_userbyid(proowner)='postgres' FROM pg_proc WHERE oid='inbox_t2_authenticated_detail.detail_v2(uuid,uuid,timestamptz,uuid)'::regprocedure;")==='t','Expected STABLE authenticated dependency');
sql(readFileSync(here+'setup.sql','utf8'));
sql(`BEGIN;INSERT INTO organizations(id,name) VALUES('${org}','Capture boundary ${org}'),('${otherOrg}','Capture boundary ${otherOrg}');INSERT INTO auth.users(id,email) VALUES('${user}','${user}@example.invalid'),('${other}','${other}@example.invalid'),('${keeper}','${keeper}@example.invalid');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('${keeper}','${org}','owner','active'),('${keeper}','${otherOrg}','owner','active'),('${user}','${org}','member','active'),('${other}','${otherOrg}','member','active');INSERT INTO messages(org_id,conversation_id,channel,direction,body) VALUES('${org}','${conv}','sms','inbound','Capture integration synthetic');COMMIT;`);
const before=detail();need(before.head_revision==='1'&&before.history.length===1,'Authorized snapshot mismatch');
const codec=createReadBoundaryCodec({currentKid:'ephemeral',keys:new Map([['ephemeral',randomBytes(32)]]),ttlSeconds:300,maxTtlSeconds:300});
const expected=(d)=>({requesterId:d.requester_id,organizationId:d.org_id,conversationId:d.conversation_id,captureGeneration:d.capture_generation});
const now=Math.floor(Date.now()/1000);
const token=codec.issue({...expected(before),headRevision:before.head_revision,snapshotId:randomUUID(),boundaryId:randomUUID()},now);
need(codec.verify(token,expected(detail()),now).headRevision==='1','Actual codec roundtrip failed');
pass('authorized DB snapshot issues actual application token and verifies against current authorized DB context');
function rejected(context,time=now){let failed=false;try{codec.verify(token,context,time);}catch{failed=true;}need(failed,'Expected application token refusal');}
rejected({...expected(before),requesterId:other});rejected({...expected(before),organizationId:otherOrg});rejected(expected(before),now+300);
denied(request({who:other}),'42501','INBOX_ACCESS_DENIED');denied(request({tenant:otherOrg}),'42501','INBOX_ACCESS_DENIED');
pass('other requester/org rejected by DB and token; expiry rejected');
for(const role of ['authenticated','service_role']){
 denied(`SET ROLE ${role};SELECT * FROM inbox_t2_capture_boundary.generation;`,'42501','permission denied');
 denied(`SET ROLE ${role};UPDATE inbox_t2_capture_boundary.generation SET generation=gen_random_uuid();`,'42501','permission denied');
}
pass('authenticated and service_role cannot read or rotate private generation directly');
// Delete only singleton inside a rolled-back transaction; source heads remain intact.
const missing=`BEGIN;DELETE FROM inbox_t2_capture_boundary.generation;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claims=${lit(JSON.stringify({sub:user,role:'authenticated'}))};SELECT inbox_t2_capture_boundary.detail('${org}','${conv}');ROLLBACK;`;
denied(missing,'55000','INBOX_CAPTURE_METADATA_UNAVAILABLE');
need(detail().capture_generation===before.capture_generation,'Failed missing-metadata check changed generation');
pass('missing generation fails closed; aborted test restores singleton');
// Hold a statement snapshot in pg_sleep, then rotate from another connection.
const appName='capture-boundary-'+randomUUID();
const query=request({query:`WITH pause AS MATERIALIZED (SELECT pg_sleep(3)) SELECT inbox_t2_capture_boundary.detail('${org}','${conv}') FROM pause;`});
const child=spawn('docker',docker,{stdio:['pipe','pipe','pipe']});
let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
try{
 child.stdin.end(prefix+`SET application_name=${lit(appName)};`+query);
 const deadline=Date.now()+5000;let sleeping=false;
 while(Date.now()<deadline){if(sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${lit(appName)} AND wait_event='PgSleep');`)==='t'){sleeping=true;break;}await new Promise(r=>setTimeout(r,20));}
 need(sleeping,'Snapshot barrier was not observed');
 const next=randomUUID();sql(`UPDATE inbox_t2_capture_boundary.generation SET generation='${next}' WHERE singleton IS TRUE;`);
 need(await done===0,'Held snapshot failed: '+errors);
 const held=JSON.parse(output.trim());need(held.capture_generation===before.capture_generation&&held.head_revision===before.head_revision,'One MVCC snapshot mixed generation');
 const current=detail();need(current.capture_generation===next&&current.head_revision===before.head_revision,'Rotation changed head or failed persistence');
 rejected(expected(current));
 pass('concurrent generation rotation preserves statement snapshot; subsequent current-context verification rejects old token without head reset');
}finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');await done.catch(()=>{});}
need(sql("SELECT md5(pg_get_functiondef('inbox_t2_authenticated_detail.detail_v2(uuid,uuid,timestamptz,uuid)'::regprocedure));")===underlyingBefore,'Existing authenticated function changed');
need(sql(`SELECT count(*) FROM messages WHERE org_id='${org}' AND conversation_id='${conv}' AND read_at IS NOT NULL;`)==='0','Integration marked messages read');
pass('original authenticated function preserved; no read acknowledgment occurred');
writeFileSync(here+'evidence.json',JSON.stringify({at:new Date().toISOString(),node:process.version,checks,org,conversation:conv,token_sha256:createHash('sha256').update(token).digest('hex'),codec_sha256:createHash('sha256').update(readFileSync(new URL('../../../src/lib/inbox/read-boundary.ts',import.meta.url))).digest('hex'),limits:['Dedicated random signing key only in process memory; no key or full token logged','Simulated trusted claims; no HTTP/JWT/PostgREST/gateway proof','Generation rotation does not repair bypassed writers or restores; capture fencing still required','No acknowledgment receipts or replay prevention; live access and generation must be rechecked during writes','Private fixture wrapper only, no production migration or route activation']},null,2)+'\n');
console.log(JSON.stringify({passed:checks.length,checks},null,2));
