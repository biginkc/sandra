import http from 'node:http';
import pg from 'pg';
import * as restate from '@restatedev/restate-sdk';
import {createEndpointHandler} from '@restatedev/restate-sdk/node';
import {createRunner,dispatchBatch,workerConfiguration,createReadinessProbe,createRestateReadinessProbe,databaseConfiguration} from './core.mjs';
if(process.env.INBOX_ACTION_WORKER_ENABLED!=='1')throw Error('Inbox action worker is disabled');
if(!process.env.INBOX_ACTION_DATABASE_URL||!process.env.INBOX_RESTATE_INGRESS_URL)throw Error('Private worker configuration missing');
const {ingress,identityKeys,connections}=workerConfiguration(process.env);
const pool=new pg.Pool({...databaseConfiguration(process.env),max:connections,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,statement_timeout:15000,query_timeout:20000,application_name:'sandra-inbox-action-worker'});
const authority=(await pool.query(`SELECT current_user AS role,
 NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS constrained
 FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
if(authority?.role!=='inbox_action_worker'||authority.constrained!==true)throw Error('Dedicated constrained action worker role required');
const runner=createRunner(pool);
const service=restate.service({name:'InboxMetadataOperation',handlers:{run:async(ctx,input)=>{
 const operation=await ctx.run('load-immutable-operation',()=>runner.load(input));
 const results=[];
 for(const stepId of operation.steps)results.push(await ctx.run(`step:${stepId}`,()=>runner.step(operation,stepId)));
 return {operationId:operation.operationId,states:results};
}}});
const endpoint=createEndpointHandler({services:[service],identityKeys});
let stopping=false,lastDispatchOk=0,inflight;
const engineReadiness=createRestateReadinessProbe(fetch,ingress);
const readiness=createReadinessProbe(async()=>await engineReadiness.read()&&(await pool.query('SELECT inbox_action_api.worker_readiness() AS ready')).rows[0]?.ready===true);
async function dispatch(){
 if(stopping)return;
 try{if(!await readiness.read()){lastDispatchOk=0;return;}await dispatchBatch(pool,fetch,ingress);lastDispatchOk=Date.now();}
 catch{lastDispatchOk=0;readiness.invalidate();process.stderr.write('Inbox action dispatch unavailable; durable outbox retained\n');}
}
const timer=setInterval(()=>{if(!inflight)inflight=dispatch().finally(()=>{inflight=undefined;});},1000);
const server=http.createServer(async(req,res)=>{
 if(req.url==='/readyz'){
  let healthy=false;
  try{healthy=!stopping&&Date.now()-lastDispatchOk<5000&&await readiness.read();}catch{}
  res.writeHead(healthy?200:503,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ready:healthy}));return;
 }
 if(stopping){res.writeHead(503);res.end();return;}
 return endpoint(req,res);
});
server.listen(Number(process.env.PORT??9080),process.env.INBOX_WORKER_BIND??'127.0.0.1');
async function shutdown(){if(stopping)return;stopping=true;clearInterval(timer);server.close();await inflight;await pool.end();}
process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
