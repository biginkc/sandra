import pg from 'pg';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {projectionRound} from './core.mjs';
import {databaseConfig,assertLogin} from './config.mjs';
const database=databaseConfig(process.env);
const batchSize=Number(process.env.INBOX_PROJECTION_BATCH_SIZE??25);
const idleMs=Number(process.env.INBOX_PROJECTION_IDLE_MS??1000);
const port=Number(process.env.PORT??9081);
if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100||!Number.isInteger(idleMs)||idleMs<100||idleMs>10000||!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid projection bounds');
let stopping=false,lastSuccess=0,lastResult=null,failed=false;
const pool=new pg.Pool({...database,max:1,idleTimeoutMillis:0,connectionTimeoutMillis:5000,statement_timeout:30000,lock_timeout:2000,idle_in_transaction_session_timeout:10000,application_name:'sandra-inbox-projection',
  onConnect:async client=>{
    await client.query('SET ROLE inbox_projection_worker');
    const row=(await client.query(`SELECT current_user AS role,current_database() AS database,session_user AS login,
      (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls) AS login_safe,
      (SELECT count(*)=1 AND bool_and(m.roleid='inbox_projection_worker'::regrole AND NOT m.admin_option) FROM pg_auth_members m WHERE m.member=r.oid) AS only_projection_membership,
      NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_schema_privilege(session_user,n.oid,'USAGE') AND has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS no_direct_data,
      NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prosecdef AND p.prorettype<>'trigger'::regtype AND has_schema_privilege(session_user,n.oid,'USAGE') AND has_function_privilege(session_user,p.oid,'EXECUTE') AND p.oid<>ALL(ARRAY['inbox_control.seed_baseline_batch(integer)'::regprocedure,'inbox_control.wake_due_expiries(integer)'::regprocedure,'inbox_control.readiness()'::regprocedure,'inbox_backfill.claim(integer,integer)'::regprocedure,'inbox_backfill.batch(uuid,uuid,integer)'::regprocedure,'inbox_parent.claim(integer,integer)'::regprocedure,'inbox_parent.batch(uuid,text,uuid,uuid,integer)'::regprocedure,'inbox_maintained.claim_work(integer,integer)'::regprocedure,'inbox_maintained.snapshot(uuid,text,uuid,timestamptz)'::regprocedure,'inbox_maintained.finish_work(uuid,jsonb)'::regprocedure]::oid[])) AS only_expected_definers
      FROM pg_roles r WHERE r.rolname=session_user`)).rows[0];
    assertLogin(row);
    if(row.role!=='inbox_projection_worker'||(process.env.INBOX_PROJECTION_EXPECT_DATABASE&&row.database!==process.env.INBOX_PROJECTION_EXPECT_DATABASE))throw Error('Projection database identity mismatch');
  }});
pool.on('error',()=>{failed=true;stopping=true;process.exitCode=1;console.error(JSON.stringify({event:'projection_connection_error'}));});
const server=createServer((req,res)=>{
  if(req.method!=='GET'||req.url!=='/health'){res.writeHead(404);res.end();return;}
  const healthy=!failed&&!stopping&&lastSuccess>0&&Date.now()-lastSuccess<60000;
  res.writeHead(healthy?200:503,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify({healthy,lastSuccess,counts:lastResult?.counts??null,poisoned:lastResult?.counts?.poisoned??0,poolConnections:pool.totalCount}));
});
server.listen(port,process.env.INBOX_PROJECTION_BIND??'0.0.0.0');
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
try{
  while(!stopping){
    const started=performance.now();const client=await pool.connect();
    try{lastResult=await projectionRound(client,{batchSize,shouldStop:()=>stopping});}finally{client.release();}
    if(lastResult.stopped)break;
    lastSuccess=Date.now();
    const worked=lastResult.counts.summary+lastResult.counts.parent+lastResult.counts.backfill+lastResult.counts.expiry+lastResult.counts.poisoned;
    if(worked)console.log(JSON.stringify({event:'projection_round',elapsedMs:performance.now()-started,...lastResult}));
    await delay(worked?10:idleMs);
  }
}catch(error){failed=true;process.exitCode=1;console.error(JSON.stringify({event:'projection_stopped',code:typeof error?.code==='string'?error.code:'worker_error'}));}
finally{stopping=true;server.close();await pool.end();}
