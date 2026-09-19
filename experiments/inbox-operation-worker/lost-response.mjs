// Owned fault transport: close a real HTTP response after durable acceptance
// headers, before the caller can receive/validate its invocation receipt.
import http from 'node:http';
import pg from 'pg';
import {dispatchBatch,databaseConfiguration,workerConfiguration} from './core.mjs';
const mode=process.argv[2];if(!['lose','retry'].includes(mode)||process.env.INBOX_ACTION_LOCAL_FIXTURE!=='1')throw Error('Owned fault mode required');
const pool=new pg.Pool({...databaseConfiguration(process.env),max:1,connectionTimeoutMillis:3000});
const {ingress}=workerConfiguration(process.env);let durableStatus=null,acceptance=null;
try{
 const fetcher=mode==='lose'?(url,options)=>new Promise((resolve,reject)=>{
  const req=http.request(url,{method:options.method,headers:options.headers,signal:options.signal},response=>{
   durableStatus=response.statusCode;
   response.destroy();req.destroy();reject(Object.assign(Error('Owned response loss after headers'),{code:'OWNED_RESPONSE_LOSS'}));
  });
  req.on('error',reject);req.end(options.body);
 }):async(url,options)=>{const response=await fetch(url,options);acceptance=await response.clone().json();return response;};
 try{
  const accepted=await dispatchBatch(pool,fetcher,ingress);
  if(mode==='lose')throw Error('Expected actual transport loss');
  if(accepted!==1||acceptance?.status!=='PreviouslyAccepted')throw Error('Expected same-event durable replay');
  console.log(JSON.stringify({accepted,acceptance}));
 }catch(error){
  if(mode!=='lose'||error.code!=='OWNED_RESPONSE_LOSS'||![200,202].includes(durableStatus))throw error;
  console.log(JSON.stringify({lost:true,durableStatus}));
 }
}finally{await pool.end();}
