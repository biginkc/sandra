import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createWorkspaceSync, type WorkspaceScope } from "../../src/lib/inbox/workspace-sync";
import { workspaceId } from "../../src/components/inbox-workspace/selection";

async function main() {
if (!process.argv.includes("--run-owned-fixture")) throw Error("Explicit --run-owned-fixture required");
const dockerHost = "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock";
const inspected = JSON.parse(execFileSync("docker",["--host",dockerHost,"inspect","sandra-inbox-stack-electric"],{encoding:"utf8"}))[0];
assert.equal(inspected.Id,"ede8887c1b120d49bca326f3909af58af47b362f58ba9f7cae0f719bf898de8c");
assert.equal(inspected.Config.Image,"electricsql/electric:1.8.1@sha256:efb6fa43859d67cb8c73439e0c8bc0f7a3daa467500fb06f2a924bcb2070c139");
assert.equal(inspected.State.Running,true);
assert.deepEqual(inspected.HostConfig.PortBindings,{"3000/tcp":[{HostIp:"127.0.0.1",HostPort:"58783"}]});
const env = Object.fromEntries(inspected.Config.Env.map((line:string)=>[line.slice(0,line.indexOf("=")),line.slice(line.indexOf("=")+1)]));
assert.equal(env.ELECTRIC_MANUAL_TABLE_PUBLISHING,"true");
assert.equal(env.ELECTRIC_REPLICATION_STREAM_ID,"inbox_t1");
const db = new pg.Client({connectionString:"postgres://postgres@127.0.0.1:58782/sandra_inbox_t1"});
let evidence:Record<string,unknown>|undefined;
try {
await db.connect();
const marker = (await db.query("select current_database() as name, marker from inbox_t1.fixture_identity")).rows;
assert.deepEqual(marker,[{name:"sandra_inbox_t1",marker:"sandra-inbox-stack-t1-owned-synthetic"}]);
const publication = "electric_publication_inbox_t1";
assert.equal((await db.query("select puballtables from pg_publication where pubname=$1",[publication])).rows[0]?.puballtables,false);
const previousTables = (await db.query("select schemaname,tablename from pg_publication_tables where pubname=$1 order by 1,2",[publication])).rows;
const schema = `inbox_ws_sync_${Date.now()}`;
const org = randomUUID(), foreignOrg = randomUUID(), known = randomUUID(), unknown = randomUUID(), user = randomUUID();
const scopeId = randomUUID(), foreignScopeId = randomUUID();
let server:Server|undefined; let sync:ReturnType<typeof createWorkspaceSync>|undefined; let created=false;
let active = true; let holdForward: (()=>Promise<void>)|undefined;
const controllers = new Set<AbortController>();
const stats = { upstreamRequests:0, forwardedMessages:0, denied:0, maxResponseBytes:0, shapes:new Set<string>(), operations:[] as string[], partialUpdate:false, noForeignRows:true };
const checks:string[]=[];
async function until(test:()=>boolean,label:string) { const end=Date.now()+12000; while(!test()) {if(Date.now()>end)throw Error(`Timeout: ${label}`); await new Promise(r=>setTimeout(r,25));} }
try {
  await db.query(`create schema ${schema}; create table ${schema}.summaries (
    org_id uuid not null,target_kind text not null,target_id uuid not null,
    name text not null,context text not null,preview text not null,time_label text not null,
    outcome_label text not null,assigned_label text not null,unread boolean not null,
    primary key(org_id,target_kind,target_id));
    alter table ${schema}.summaries replica identity full;
    alter table ${schema}.summaries enable row level security;
    revoke all on schema ${schema} from public;
    alter publication ${publication} add table ${schema}.summaries;`);
  created=true;
  const row=(orgId:string,id:string,kind:string,name:string)=>[orgId,kind,id,name,"Synthetic context","Initial preview","Now","New","Unassigned",true];
  for(const values of [row(org,known,"known_conversation","Known"),row(org,unknown,"unknown_sender","Unknown"),row(foreignOrg,known,"known_conversation","Foreign must not appear"),row(org,known,"unknown_sender","Opposite kind must not appear")])
    await db.query(`insert into ${schema}.summaries values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,values);
  const scopes = new Map<string,{org:string;ids:string[];handle:string}>([[scopeId,{org,ids:[known,unknown],handle:""}],[foreignScopeId,{org:foreignOrg,ids:[known],handle:""}]]);
  server=createServer(async(req,res)=> {
    try {
      // Synthetic owned session only. No production credential or cookie is read.
      if(req.headers.cookie!=="inbox_fixture_session=owned-a") {res.writeHead(401).end();return;}
      if(!active) {res.writeHead(403).end();return;}
      const url=new URL(req.url!,"http://127.0.0.1");
      const requested=url.pathname.split("/").at(-1)!;
      const scope=scopes.get(requested);
      if(req.method!=="GET" || url.pathname!==`/api/inbox/sync/${requested}` || !scope || scope.org!==org) {stats.denied++;res.writeHead(403).end();return;}
      const allowed=new Set(["offset","handle","live","cursor","log"]);
      for(const k of url.searchParams.keys()) if(!allowed.has(k) || url.searchParams.getAll(k).length!==1) {stats.denied++;res.writeHead(400).end();return;}
      const offset=url.searchParams.get("offset")??"-1";
      if(!/^(-1|\d+_(\d+|inf))$/.test(offset)) {res.writeHead(400).end();return;}
      const handle=url.searchParams.get("handle");
      if((handle && handle!==scope.handle) || (offset!=="-1"&&!handle)) {stats.denied++;res.writeHead(403).end();return;}
      if(url.searchParams.has("log")&&url.searchParams.get("log")!=="full") {res.writeHead(400).end();return;}
      const upstream=new URL("http://127.0.0.1:58783/v1/shape");
      for(const [k,v] of url.searchParams)upstream.searchParams.set(k,v);
      upstream.searchParams.set("offset",offset);
      upstream.searchParams.set("table",`${schema}.summaries`);
      upstream.searchParams.set("where","org_id=$1 AND ((target_kind = 'known_conversation' AND target_id=$2) OR (target_kind = 'unknown_sender' AND target_id=$3))");
      upstream.searchParams.set("params[1]",scope.org);
      scope.ids.forEach((id,index)=>upstream.searchParams.set(`params[${index+2}]`,id));
      // Default replica proves actual partial UPDATE and key-only DELETE protocol.
      upstream.searchParams.set("replica","default");
      const controller=new AbortController();controllers.add(controller);
      const timeout=setTimeout(()=>controller.abort(),10000);
      res.on("close",()=>{if(!res.writableEnded)controller.abort();});
      try {
        stats.upstreamRequests++;
        const upstreamResponse=await fetch(upstream,{signal:controller.signal});
        const chunks:Uint8Array[]=[];let size=0;
        const reader=upstreamResponse.body?.getReader();
        if(reader)for(;;) { const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>100000){controller.abort();throw Error("Response exceeds fixture budget");}chunks.push(value); }
        stats.maxResponseBytes=Math.max(stats.maxResponseBytes,size);
        const bytes=Buffer.concat(chunks);
        if(!upstreamResponse.ok) console.error("Electric response",upstreamResponse.status,bytes.toString().slice(0,2000));
        await holdForward?.();
        if(!active) {stats.denied++;res.writeHead(403).end();return;}
        const nextHandle=upstreamResponse.headers.get("electric-handle");if(nextHandle){scope.handle=nextHandle;stats.shapes.add(nextHandle);}
        const headers:Record<string,string>={"content-type":"application/json","cache-control":"private, no-store"};
        for(const [k,v] of upstreamResponse.headers) if(k.startsWith("electric-"))headers[k]=v;
        if(upstreamResponse.ok&&bytes.length) {
          const messages=JSON.parse(bytes.toString());
          for(const message of messages)if(message.value) {
            stats.forwardedMessages++;
            stats.operations.push(message.headers.operation);
            if(message.value.org_id!==org)stats.noForeignRows=false;
            if(message.headers.operation==="update"&&!Object.hasOwn(message.value,"name"))stats.partialUpdate=true;
          }
        }
        res.writeHead(upstreamResponse.status,headers).end(bytes);
      } finally {clearTimeout(timeout);controllers.delete(controller);}
    }catch(error) {console.error("Gateway failure",String(error));if(!res.destroyed)res.writeHead(active?503:403).end();}
  });
  // Port zero atomically reserves an unoccupied loopback port; no existing listener is replaced.
  await new Promise<void>((resolve,reject)=>{server!.once("error",reject);server!.listen(0,"127.0.0.1",resolve);});
  const address=server.address();assert(address&&typeof address!=="string");
  const origin=`http://127.0.0.1:${address.port}`;
  const request:typeof fetch=(input,init)=>fetch(input,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),cookie:"inbox_fixture_session=owned-a"}});
  const path=`${origin}/api/inbox/sync/${scopeId}`;
  const before=stats.upstreamRequests;
  for(const [url,status]of [[`${path}?where=true`,400],[`${origin}/api/inbox/sync/${foreignScopeId}`,403],[`${path}?handle=stolen&offset=1_0`,403]] as const)assert.equal((await request(url)).status,status);
  assert.equal(stats.upstreamRequests,before);checks.push("Gateway rejects SQL tampering, foreign scope and unbound handle before upstream access");
  assert.equal((await fetch(path)).status,401);checks.push("Gateway denies missing synthetic session");
  let boundaries=0;
  sync=createWorkspaceSync({origin,fetch:request,onChange:(snapshot)=>{console.log("Adapter state",snapshot.state,snapshot.rows.length);},onAccessBoundary:()=>{boundaries++;}});
  const scope:WorkspaceScope={scopeId,orgId:org,requesterId:user,sessionId:"owned-a",accessEpoch:"1",expiresAt:Date.now()+60000,
    orderedIds:[workspaceId({kind:"conversation",orgId:org,conversationId:known}),workspaceId({kind:"unknown_sender_group",orgId:org,senderGroupId:unknown})]};
  sync.replace(scope);
  await until(()=>sync!.getSnapshot().state==="live"&&sync!.getSnapshot().rows.length===2,"real snapshot");
  assert.deepEqual(sync.getSnapshot().rows.map(r=>r.name),["Known","Unknown"]);assert(stats.noForeignRows);
  checks.push("PostgreSQL → Electric 1.8.1 → scoped gateway → adapter snapshot contains exactly two authorized typed rows, excluding opposite-kind same-UUID and foreign-tenant fixtures");
  await db.query(`update ${schema}.summaries set preview='Live updated preview' where org_id=$1 and target_id=$2`,[org,known]);
  await until(()=>sync!.getSnapshot().rows[0]?.preview==="Live updated preview","partial update");
  assert.equal(sync.getSnapshot().rows[0].name,"Known");assert(stats.partialUpdate);
  checks.push("Actual partial UPDATE merges changed preview and preserves unchanged fields");
  await db.query(`delete from ${schema}.summaries where org_id=$1 and target_id=$2`,[org,unknown]);
  await until(()=>sync!.getSnapshot().rows.length===1,"delete");assert(stats.operations.includes("delete"));
  checks.push("Actual key-only DELETE removes the unknown row from collection");
  // Revoke after upstream body arrives but before forwarding, exercising the second access check.
  let captured=false;let release!:()=>void;
  const pause=new Promise<void>(resolve=>{release=resolve;});
  holdForward=async()=>{captured=true;await pause;};
  await db.query(`update ${schema}.summaries set preview='Must not be forwarded after revocation' where org_id=$1 and target_id=$2`,[org,known]);
  await until(()=>captured,"held upstream response");
  active=false;release();
  await until(()=>sync!.getSnapshot().state==="permission_lost","revocation");
  assert.deepEqual(sync.getSnapshot().rows,[]);assert.equal(boundaries,1);
  checks.push("Revocation after upstream read returns 403 before body forwarding and clears adapter rows/cache boundary");
  const files=["src/lib/inbox/workspace-sync.ts","src/lib/inbox/workspace-sync.test.ts","experiments/inbox-workspace-sync-integration/run.ts"];
  const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash("sha256").update(await readFile(file)).digest("hex")])));
  evidence={recordedAt:new Date().toISOString(),status:"passed",checks,versions:{electric:"1.8.1",client:"1.5.28",db:"0.9.0",collection:"0.4.8"},stats:{...stats,shapes:stats.shapes.size},hashes,limits:["Synthetic session gateway, not production authorization","Fixture summary DTO, not canonical T2 projection or writer capture","No browser render/latency or production acceptance measurement","No service or publication configuration changed beyond adding/removing this run's own table"]};
} finally {
  sync?.close();
  for(const c of controllers)c.abort();
  if(server)await new Promise<void>(resolve=>{server!.closeAllConnections();server!.close(()=>resolve());});
  if(created)await db.query(`drop schema ${schema} cascade`);
  assert.deepEqual((await db.query("select schemaname,tablename from pg_publication_tables where pubname=$1 order by 1,2",[publication])).rows,previousTables);
}
} finally { await db.end(); }
assert(evidence);
evidence.cleanup={schemaRemoved:true,publicationRestored:true,listenerClosed:true,databaseClientClosed:true};
await writeFile("experiments/inbox-workspace-sync-integration/evidence.json",JSON.stringify(evidence,null,2)+"\n");
console.log(JSON.stringify(evidence,null,2));
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
