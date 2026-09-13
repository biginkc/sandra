import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createInboxSyncGateway, type InboxSyncRepository, type DurableInboxScope } from "../../src/lib/inbox/sync-gateway";

async function main() {
  if (!process.argv.includes("--run-owned-fixture")) throw Error("Explicit owned-fixture flag required");
  const dockerHost = "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock";
  const inspected = JSON.parse(execFileSync("docker", ["--host", dockerHost, "inspect", "sandra-inbox-stack-electric"], { encoding: "utf8" }))[0];
  assert.equal(inspected.Id, "ede8887c1b120d49bca326f3909af58af47b362f58ba9f7cae0f719bf898de8c");
  assert.equal(inspected.Config.Image, "electricsql/electric:1.8.1@sha256:efb6fa43859d67cb8c73439e0c8bc0f7a3daa467500fb06f2a924bcb2070c139");
  assert.equal(inspected.State.Running, true);
  assert.deepEqual(inspected.HostConfig.PortBindings, { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "58783" }] });
  assert(inspected.Config.Env.includes("ELECTRIC_MANUAL_TABLE_PUBLISHING=true"));
  assert(inspected.Config.Env.includes("ELECTRIC_REPLICATION_STREAM_ID=inbox_t1"));
  const db = new pg.Client({ connectionString: "postgres://postgres@127.0.0.1:58782/sandra_inbox_t1" });
  const schema = `inbox_url_${Date.now()}`, publication = "electric_publication_inbox_t1";
  let created = false;
  let results: Record<string, unknown>[] = [];
  try {
    await db.connect();
    assert.deepEqual((await db.query("select current_database() name,marker from inbox_t1.fixture_identity")).rows, [{ name: "sandra_inbox_t1", marker: "sandra-inbox-stack-t1-owned-synthetic" }]);
    const previous = (await db.query("select schemaname,tablename from pg_publication_tables where pubname=$1 order by 1,2", [publication])).rows;
    assert.equal((await db.query("select puballtables from pg_publication where pubname=$1", [publication])).rows[0]?.puballtables, false);
    try {
      await db.query(`create schema ${schema};create table ${schema}.summaries(org_id uuid not null,target_kind text not null,target_id uuid not null,name text not null,context text not null,preview text not null,time_label text not null,outcome_label text not null,assigned_label text not null,unread boolean,primary key(org_id,target_kind,target_id));alter table ${schema}.summaries replica identity full;alter table ${schema}.summaries enable row level security;revoke all on schema ${schema} from public;alter publication ${publication} add table ${schema}.summaries`);
      created = true;
      const org = randomUUID(), user = randomUUID(), session = randomUUID();
      const targets = Array.from({ length: 500 }, (_, i) => ({ kind: i % 2 ? "known_conversation" as const : "unknown_sender" as const, id: randomUUID() }));
      await db.query(`insert into ${schema}.summaries select $1::uuid,x.kind,x.id::uuid,'Synthetic','Context','Preview','Now','New','Unassigned',true from jsonb_to_recordset($2::jsonb) x(kind text,id text)`, [org, JSON.stringify(targets)]);
      for (const count of [500]) {
        const scope: DurableInboxScope = { id: randomUUID(), orgId: org, userId: user, sessionId: session, accessEpoch: "1", generation: "1", expiresAt: Date.now() + 120000, targets: targets.slice(0, count), handles: Array(Math.ceil(count/100)).fill(null) };
        const repository: InboxSyncRepository = { authenticate: async () => ({ userId: user, sessionId: session, expiresAt: scope.expiresAt }), getAccess: async () => ({ sessionActive: true, activeMembershipCount: 1, status: "active", epoch: "1", expiresAt: scope.expiresAt, deletionPrepared: false }), getScope: async () => scope, bindHandle: async (_scope, partition, expected, next) => { if (scope.handles[partition] !== expected) return false; scope.handles[partition] = next; return true; } };
        let urlBytes = 0, upstreamStatus: number | null = null;
        const gateway = createInboxSyncGateway({ repository, electricUrl: "http://127.0.0.1:58783/v1/shape", projectionTable: `${schema}.summaries`, fetch: async (input, init) => { urlBytes = new TextEncoder().encode(String(input)).length; const response = await fetch(input, init); upstreamStatus = response.status; return response; } });
        const seen = new Set<string>();
        for (let partition=0; partition<5; partition++) {
        const response = await gateway(new Request(`http://127.0.0.1/api/inbox/sync/${scope.id}?partition=${partition}`), scope.id);
        const body = await response.json();
        const rows = Array.isArray(body) ? body.filter(item => item.headers?.operation === "insert") : [];
        assert.equal(response.status,200);
        assert.equal(rows.length, 100);
        for (const row of rows) { const key = `${row.value.target_kind}:${row.value.target_id}`; assert(!seen.has(key)); seen.add(key); }
        results.push({ requestedTargets: count, partition, urlBytes, upstreamStatus, gatewayStatus: response.status, returnedRows: rows.length, passed: response.ok && rows.length === 100 });
        }
        assert.equal(seen.size,500);
        // Exercise the actual HTTP parser with maximum accepted opaque cursor/handle sizes.
        // The deliberately stale handle may reset/deny; it must not hit the URI length limit.
        scope.handles[0] = "h".repeat(256);
        const longest = new URL(`http://127.0.0.1/api/inbox/sync/${scope.id}`);
        longest.searchParams.set("partition", "0"); longest.searchParams.set("handle", scope.handles[0]);
        longest.searchParams.set("offset", "9".repeat(62) + "_0"); longest.searchParams.set("cursor", "c".repeat(256));
        longest.searchParams.set("live", "true"); longest.searchParams.set("log", "full");
        const bounded = await gateway(new Request(longest), scope.id);
        assert.notEqual(upstreamStatus,414); assert(urlBytes < 8192);
        results.push({ purpose: "longest admitted opaque metadata; stale handle is not a row-read success claim", urlBytes, upstreamStatus, gatewayStatus: bounded.status, passed: upstreamStatus !== 414 });
      }
    } finally {
      if (created) await db.query(`drop schema ${schema} cascade`);
      assert.deepEqual((await db.query("select schemaname,tablename from pg_publication_tables where pubname=$1 order by 1,2", [publication])).rows, previous);
    }
  } finally { await db.end(); }
  const evidence = { timestamp: new Date().toISOString(), purpose: "Real Electric HTTP URL feasibility only; repository authority is synthetic and not JWT proof", sourceSha256: createHash("sha256").update(await readFile("experiments/inbox-gateway-url-proof/run.ts")).digest("hex"), gatewaySha256: createHash("sha256").update(await readFile("src/lib/inbox/sync-gateway.ts")).digest("hex"), results, cleanup: { ownedSchemaRemoved: true, publicationRestored: true, databaseClientClosed: true } };
  await writeFile("experiments/inbox-gateway-url-proof/evidence.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
