const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal=new Set(['succeeded','failed','conflicted','cancelled','blocked']);
function id(value){if(typeof value!=='string'||!UUID.test(value))throw Error('Invalid worker identity');return value;}
async function transaction(pool,statement,args){
 for(let attempt=0;;attempt++){
  try{return await pool.query(statement,args);}
  catch(error){if(attempt>=2||!['40P01','40001'].includes(error?.code))throw error;await new Promise(resolve=>setTimeout(resolve,25*2**attempt));}
 }
}
export function createRunner(pool){return {
 async load(input){
  if(!input||typeof input!=='object'||Object.keys(input).length!==2)throw Error('Invalid operation request');
  const orgId=id(input.orgId),operationId=id(input.operationId);
  const row=(await pool.query('SELECT inbox_action_api.load_operation($1,$2) AS result',[orgId,operationId])).rows[0]?.result;
  if(!row||row.org_id!==orgId||row.operation_id!==operationId||!Array.isArray(row.steps)||!row.steps.length||row.steps.length>1000)throw Error('Accepted operation unavailable');
  const steps=row.steps.map(id);if(new Set(steps).size!==steps.length)throw Error('Duplicate accepted step');
  return {orgId,operationId,steps};
 },
 async step(operation,stepId){
  id(stepId);if(!operation.steps.includes(stepId))throw Error('Unaccepted step');
  const row=(await transaction(pool,'SELECT inbox_action_api.run_step($1,$2,$3) AS result',[id(operation.orgId),id(operation.operationId),stepId])).rows[0]?.result;
  if(!row||row.step_id!==stepId||!terminal.has(row.state)||!row.receipt||typeof row.receipt!=='object')throw Error('Missing terminal step receipt');
  return {stepId,state:row.state};
 }
};}
export async function dispatchBatch(pool,fetcher,ingress){
 const entries=(await transaction(pool,'SELECT inbox_action_api.claim_dispatch_batch(20) AS result',[])).rows[0]?.result;
 if(!Array.isArray(entries)||entries.length>20)throw Error('Invalid dispatch batch');
 let accepted=0;
 // Bounded sequential dispatch; no unbounded fan-out or browser dependency.
 for(const entry of entries){
  const orgId=id(entry.org_id),operationId=id(entry.operation_id),eventId=id(entry.event_id);
  if(typeof entry.generation!=='string'||!/^[1-9][0-9]{0,18}$/.test(entry.generation)||BigInt(entry.generation)>9223372036854775807n)throw Error('Invalid dispatch fence');
  const response=await fetcher(new URL('/InboxMetadataOperation/run/send',ingress),{method:'POST',headers:{'content-type':'application/json','idempotency-key':eventId},body:JSON.stringify({orgId,operationId}),signal:AbortSignal.timeout(5000),redirect:'error'});
  const body=await readBoundedJson(response,4096);
  if(!['Accepted','PreviouslyAccepted'].includes(body.status)||typeof body.invocationId!=='string'||!/^inv_[A-Za-z0-9]+$/.test(body.invocationId))throw Error('Durable acceptance not confirmed');
  // No acknowledgment on a thrown/lost response. A later dispatcher reuses the
  // immutable event key; SQL step receipts also protect past engine retention.
  const acknowledgment=await transaction(pool,'SELECT inbox_action_api.ack_dispatch($1,$2,$3) AS result',[orgId,operationId,entry.generation]);
  if(acknowledgment.rows[0]?.result!==true)throw Error('Dispatch acknowledgment fence expired');accepted++;
 }
 return accepted;
}
export function workerConfiguration(env){
 const ingress=new URL(env.INBOX_RESTATE_INGRESS_URL??'');
 const allowed=new Set(['inbox-restate.railway.internal','sandra-inbox-restate-owned']);
 if(ingress.protocol!=='http:'||!allowed.has(ingress.hostname)||ingress.port!=='8080'||ingress.username||ingress.password||ingress.search||ingress.hash||ingress.pathname!=='/')throw Error('Unapproved private Restate ingress');
 let identityKeys;try{identityKeys=JSON.parse(env.INBOX_RESTATE_IDENTITY_KEYS??'');}catch{throw Error('Restate signing keys required');}
 if(!Array.isArray(identityKeys)||identityKeys.length<1||identityKeys.length>2||identityKeys.some(k=>typeof k!=='string'||!/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(k)))throw Error('Invalid Restate signing keys');
 const connections=Number(env.INBOX_ACTION_CONNECTIONS??2);
 if(!Number.isInteger(connections)||connections<1||connections>2)throw Error('Action connection budget exceeds two');
 return {ingress,identityKeys,connections};
}
export function createReadinessProbe(check,clock=Date.now){
 let pending,cached=false,until=0,generation=0;
 return {
  invalidate(){generation++;cached=false;until=clock()+2000;},
  async read(){
   if(clock()<until)return cached;
   if(pending)return pending;
   const captured=generation;
   pending=(async()=>{let result=false;try{result=await check()===true;}catch{}
    if(captured===generation){cached=result;until=clock()+2000;}
    return captured===generation?result:false;
   })().finally(()=>{pending=undefined;});
   return pending;
  }
 };
}
export function databaseConfiguration(env){
 const url=new URL(env.INBOX_ACTION_DATABASE_URL??'');
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||url.hash||!url.username||!url.password||url.port!=='5432')throw Error('Invalid dedicated database connection');
 const database=decodeURIComponent(url.pathname.slice(1));
 let ssl={rejectUnauthorized:true,servername:url.hostname};
 if(env.INBOX_ACTION_LOCAL_FIXTURE==='1'){
  if(env.NODE_ENV!=='test'||url.hostname!=='sandra-inbox-actions-db-owned'||database!=='sandra_inbox_action_runtime_20260913')throw Error('Unapproved plaintext fixture database');
  ssl=false;
 }else{
  if(!url.hostname.endsWith('.supabase.co')&&!url.hostname.endsWith('.pooler.supabase.com'))throw Error('Unapproved production database host');
  if(env.INBOX_ACTION_DATABASE_CA){if(!env.INBOX_ACTION_DATABASE_CA.includes('-----BEGIN CERTIFICATE-----'))throw Error('Invalid database CA');ssl.ca=env.INBOX_ACTION_DATABASE_CA;}
 }
 return {host:url.hostname,port:5432,user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database,ssl};
}

async function readBoundedJson(response,limit){
 if(!response.ok){try{await response.body?.cancel();}catch{}throw Error('Durable dispatch rejected');}
 if(!response.body)throw Error('Missing bounded response');
 const reader=response.body.getReader();const chunks=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw Error('Invalid durable dispatch response');}chunks.push(part.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function createRestateReadinessProbe(fetcher,ingress,clock=Date.now){
 return createReadinessProbe(async()=>{
  const response=await fetcher(new URL('/restate/health',ingress),{method:'GET',signal:AbortSignal.timeout(1500),redirect:'error'});
  const body=await readBoundedJson(response,16384);
  return Array.isArray(body?.services)&&body.services.length<=500&&body.services.every(s=>typeof s==='string')&&body.services.includes('InboxMetadataOperation');
 },clock);
}
