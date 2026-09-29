const fs=require('fs');
const path=require('path');
const {spawn}=require('child_process');
const {Client}=require('pg');
const root=process.env.PERF_RUN_DIR, url=process.env.PERF_DATABASE_URL;
const source=process.env.PERF_MIGRATIONS_DIR;
const files=['20260929000000_inbox_control_foundation.sql','20260929000100_inbox_read_companion.sql','20260929000200_inbox_backend_operation_reply.sql'];
for (const file of files) if (!fs.statSync(path.join(source,file)).isFile()) throw Error('Missing required checked-out migration: '+file);
const ms=x=>Number(x)/1e6;
const sleep=x=>new Promise(r=>setTimeout(r,x));
async function run(file){
 const monitor=new Client({connectionString:url}),writer=new Client({connectionString:url});
 await monitor.connect();await writer.connect();
 const lockFile=fs.createWriteStream(`${root}/${file}.locks.csv`);
 const writeFile=fs.createWriteStream(`${root}/${file}.writer.csv`);
 lockFile.write('elapsed_ms,granted_access_exclusive_messages,waiting_locks,access_exclusive_pids\n');
 writeFile.write('elapsed_ms,statement_ms,error\n');
 const child=spawn('psql',[url,'-X','-v','ON_ERROR_STOP=1','-f',path.join(source,file)],{stdio:['ignore','pipe','pipe']});
 const out=fs.createWriteStream(`${root}/${file}.psql.log`);child.stdout.pipe(out);child.stderr.pipe(out);
 let running=true,monitorError=null,writerError=null;
 const start=process.hrtime.bigint(),holds=[],waits=[],writes=[];
 const monitorTask=(async()=>{while(running){
  try{
   const q=await monitor.query("SELECT coalesce(bool_or(granted AND mode='AccessExclusiveLock' AND relation='public.messages'::regclass),false) AS exclusive, count(*) FILTER (WHERE NOT granted)::integer AS waiting, coalesce(string_agg(pid::text,',' ORDER BY pid) FILTER (WHERE granted AND mode='AccessExclusiveLock' AND relation='public.messages'::regclass),'') AS pids FROM pg_locks WHERE relation IS NOT NULL");
   const t=ms(process.hrtime.bigint()-start),v=q.rows[0];
   lockFile.write(`${t.toFixed(3)},${v.exclusive},${v.waiting},${v.pids}\n`);
   holds.push({t,exclusive:v.exclusive});waits.push(Number(v.waiting));
  }catch(e){monitorError=e;break} await sleep(50);
 }})();
 const writerTask=(async()=>{while(running){
  const before=process.hrtime.bigint();let error='';
  try{await writer.query("UPDATE public.messages SET metadata=jsonb_build_object('d7_writer',clock_timestamp()::text) WHERE id=(SELECT id FROM public.messages ORDER BY id LIMIT 1)")}
  catch(e){error=e.code||e.message;writerError=e}
  const t=ms(process.hrtime.bigint()-start),d=ms(process.hrtime.bigint()-before);
  writeFile.write(`${t.toFixed(3)},${d.toFixed(3)},${error}\n`); writes.push(d);
  if(error)break;await sleep(20);
 }})();
 const exit=await new Promise(resolve=>child.on('close',resolve));running=false;
 await Promise.all([monitorTask,writerTask]);
 await new Promise(r=>lockFile.end(r));await new Promise(r=>writeFile.end(r));
 await monitor.end();await writer.end();
 let span=0,beg=null;for(const h of holds){if(h.exclusive&&beg===null)beg=h.t;if(!h.exclusive&&beg!==null){span=Math.max(span,h.t-beg);beg=null}}
 if(beg!==null)span=Math.max(span,ms(process.hrtime.bigint()-start)-beg);
 const result={file,exit,wall_ms:ms(process.hrtime.bigint()-start),sample_interval_ms:50,access_exclusive_messages_observed_ms:span,access_exclusive_samples:holds.filter(h=>h.exclusive).length,max_waiting_locks:Math.max(...waits,0),writer_count:writes.length,writer_max_ms:Math.max(...writes,0),monitor_error:monitorError?.message||null,writer_error:writerError?.message||null};
 fs.writeFileSync(`${root}/${file}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 if(exit!==0||monitorError||writerError)throw new Error('Migration/monitor failure: '+file);
}
(async()=>{for(const f of files)await run(f)})().catch(e=>{console.error(e);process.exit(1)});
