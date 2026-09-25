import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, open } from "node:fs/promises";
const docker = ["--host","unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock"];
const target="sandra-inbox-projection-t2-db", database="sandra_inbox_install_20260913", marker="sandra-inbox-production-candidate-owned-synthetic";
const image="electricsql/electric:1.8.1@sha256:efb6fa43859d67cb8c73439e0c8bc0f7a3daa467500fb06f2a924bcb2070c139";
const stamp=Date.now(), role=`inbox_browser_repl_${stamp}`, stream=`inbox_browser_${stamp}`, publication=`electric_publication_${stream}`, container=`${stream}-electric`;
const password=randomBytes(24).toString("hex");
let next:ChildProcess|undefined, createdRole=false, createdPublication=false, createdContainer=false, enabledGate=false, stopped=false;
const records: {path:string;status:number;durationMs:number;bytes:number}[]=[];
function run(args:string[], input="", env=process.env) { return new Promise<string>((resolve,reject)=>{
  const child=spawn("docker",[...docker,...args],{env,stdio:["pipe","pipe","pipe"]});let out="";
  child.stdout.on("data",data=>{out+=data;if(out.length>3_000_000)child.kill();});child.stderr.resume();
  child.on("error",()=>reject(Error("Owned Docker command unavailable")));child.on("close",code=>code===0?resolve(out.trim()):reject(Error(`Owned Docker command failed (${code})`)));child.stdin.end(input);
});}
const sql=(query:string)=>run(["exec","-i",target,"psql","-XqAt","-U","supabase_admin","-d",database,"-v","ON_ERROR_STOP=1"],query);
const quote=(value:string)=>value.replaceAll("\\","\\\\").replaceAll('"','\\"').replaceAll("\r","\\r").replaceAll("\n","\\n");
const relay=createServer(async(req,res)=>{const started=performance.now();try{
  const url=new URL(req.url??"/","http://127.0.0.1");
  if(req.method!=="GET"||url.pathname!=="/v1/shape"||url.searchParams.get("table")!=="inbox_bridge.summaries"){res.writeHead(404).end();return;}
  const raw=await run(["exec","-i",target,"curl","--config","-"],[`url = "http://127.0.0.1:3000${quote(url.pathname+url.search)}"`,"include","silent","show-error","max-time = 14",'header = "Accept-Encoding: identity"'].join("\n"));
  const split=raw.indexOf("\r\n\r\n");assert(split>=0);const lines=raw.slice(0,split).split("\r\n"),status=Number(lines[0].match(/^HTTP\/\S+ (\d+)/)?.[1]),body=raw.slice(split+4);assert(Buffer.byteLength(body)<=2_097_152);
  res.statusCode=status;for(const line of lines.slice(1)){const i=line.indexOf(":");if(i<0)continue;const key=line.slice(0,i),value=line.slice(i+1).trim();if(!["content-length","content-encoding","transfer-encoding","connection"].includes(key.toLowerCase()))res.setHeader(key,value);}
  records.push({path:url.pathname,status,durationMs:performance.now()-started,bytes:Buffer.byteLength(body)});res.end(body);
}catch{res.writeHead(503).end();}});
async function cleanup(){if(stopped)return;stopped=true;next?.kill("SIGTERM");relay.close();if(enabledGate)await sql("UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton=true");if(createdContainer)await run(["rm","-f",container]);if(createdPublication)await sql(`DROP PUBLICATION ${publication}`);await sql(`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='electric_slot_${stream}' AND NOT active`);if(createdRole)await sql(`DROP OWNED BY ${role};DROP ROLE ${role}`);await writeFile("experiments/inbox-next-browser-proof/application-polls.json",JSON.stringify(records,null,2)+"\n");}
async function main(){assert(process.argv.includes("--run-owned-installed-fixture"));
 for(const name of [".env",".env.local",".env.development",".env.development.local"]){const present=await readFile(name).then(()=>true,error=>{if(error.code!=="ENOENT")throw error;return false;});assert(!present,"Owned Next process refuses ambient dotenv files");}
 const info=JSON.parse(await run(["inspect",target]))[0];assert.equal(info.Id,"603c10117cb7ef6a07d81448dd1a25b0c1ee2787a59f75871015c4a416cac557");assert.equal(info.HostConfig.NetworkMode,"none");assert.equal(info.HostConfig.Memory,536870912);
 assert.equal(await sql("SELECT marker FROM install_fixture.identity"),marker);assert.equal(await sql("SHOW cron.launch_active_jobs"),"off");assert.equal(await sql("SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass"),"f","Narrow projection requires FULL replica identity");
 assert.equal(await sql("SELECT to_regprocedure('public.inbox_history_page(uuid,uuid,uuid)') IS NOT NULL AND to_regprocedure('public.inbox_read_detail(uuid,uuid)') IS NOT NULL AND to_regprocedure('public.inbox_acknowledge_read(uuid,integer)') IS NOT NULL"),"t");
 assert.equal(await sql("SELECT serving_enabled FROM inbox_control.rollout WHERE singleton=true"),"f");
 await sql("UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton=true");enabledGate=true;
 await run(["image","inspect",image]);
 await sql(`CREATE ROLE ${role} LOGIN REPLICATION BYPASSRLS PASSWORD '${password}' CONNECTION LIMIT 4;GRANT CONNECT ON DATABASE ${database} TO ${role};GRANT USAGE ON SCHEMA inbox_bridge TO ${role};GRANT SELECT ON inbox_bridge.summaries TO ${role}`);createdRole=true;
 await sql(`CREATE PUBLICATION ${publication} FOR TABLE inbox_bridge.summaries`);createdPublication=true;
 await run(["run","-d","--name",container,"--label",`com.bmh.inbox-fixture=${marker}`,"--network",`container:${target}`,"--memory","512m","--cpus","1","--env","DATABASE_URL","--env","ELECTRIC_INSECURE=true","--env","ELECTRIC_MANUAL_TABLE_PUBLISHING=true","--env",`ELECTRIC_REPLICATION_STREAM_ID=${stream}`,"--env","ELECTRIC_LONG_POLL_TIMEOUT=8000","--env","ELECTRIC_TELEMETRY=false","--env","ELECTRIC_DB_POOL_SIZE=2","--env","ELECTRIC_MAX_SHAPES=16",image],"",{...process.env,DATABASE_URL:`postgres://${role}:${password}@127.0.0.1:5432/${database}?sslmode=disable`});createdContainer=true;
 await new Promise<void>(resolve=>relay.listen(0,"127.0.0.1",resolve));const address=relay.address();assert(address&&typeof address!=="string");const electricUrl=`http://127.0.0.1:${address.port}/v1/shape`;
 const foundation=JSON.parse(await readFile("experiments/inbox-next-browser-proof/foundation-evidence.json","utf8"));assert.equal(foundation.database,database);
 // Reserve an ephemeral loopback port, then let Next claim it; fail rather than reuse another server on a race.
 const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,"127.0.0.1",resolve));const nextAddress=reservation.address();assert(nextAddress&&typeof nextAddress!=="string");const nextPort=nextAddress.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
 const log=await open("/tmp/sandra-real-inbox-next.log","w");
 // G4 (#592): this loopback Electric has no relay/token in front of it. Without an explicit mode,
 // sync-upstream-config.ts defaults to "relay" and fails closed (https + token required) against
 // this http://127.0.0.1 upstream. Declare the dev/test-only owned-local profile explicitly instead
 // of relying on a default, and record the mode actually exercised in the evidence file below.
 const upstreamMode="owned-local";
 next=spawn(process.execPath,["node_modules/next/dist/bin/next","dev","--hostname","127.0.0.1","--port",String(nextPort)],{stdio:["ignore",log.fd,log.fd],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:"development",NEXT_TELEMETRY_DISABLED:"1",NEXT_PUBLIC_SUPABASE_URL:foundation.origin,NEXT_PUBLIC_SUPABASE_ANON_KEY:"owned-fixture-anon-key",INBOX_WORKSPACE_SERVER_ENABLED:"1",INBOX_ELECTRIC_UPSTREAM_MODE:upstreamMode,INBOX_ELECTRIC_SHAPE_URL:electricUrl,INBOX_ELECTRIC_PROJECTION_TABLE:"inbox_bridge.summaries",NEXT_PUBLIC_HUGO_SSO:"1",E2E_AUTH_BYPASS:"1"}});
 next.on("exit",code=>{if(!stopped){console.error(`Owned Next exited (${code})`);void cleanup();}});
 const evidence={database,marker,image,container,role,publication,stream,electricUrl,upstreamMode,nextOrigin:`http://127.0.0.1:${nextPort}`,authOrigin:foundation.origin,nextPid:next.pid,processId:process.pid,longPollMs:8000,note:"Real local password-test lane; production Hugo OAuth is not proven. Host namespace relay overhead included in timings."};await writeFile("experiments/inbox-next-browser-proof/application-evidence.json",JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
 setInterval(()=>{void writeFile("experiments/inbox-next-browser-proof/application-polls.json",JSON.stringify(records,null,2)+"\n");},5000).unref();setTimeout(()=>{void cleanup().finally(()=>process.exit(0));},3_300_000);
}
process.on("SIGINT",()=>{void cleanup().finally(()=>process.exit(0));});process.on("SIGTERM",()=>{void cleanup().finally(()=>process.exit(0));});main().catch(async()=>{console.error("Owned application harness failed; no secrets logged");await cleanup();process.exitCode=1;});
