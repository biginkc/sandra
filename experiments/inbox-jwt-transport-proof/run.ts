import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHmac, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServerClient } from "@supabase/ssr";
import { createSupabaseInboxRepository, type InboxRpcClient } from "../../src/lib/inbox/supabase-sync-repository";
import { createInboxWorksetHandler } from "../../src/lib/inbox/workset-handler";

const docker = ["--host", "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock"];
const database = "sandra-inbox-projection-t2-db";
const image = "public.ecr.aws/supabase/postgrest@sha256:5922bde07147b82b1c9d8f749e48c1e5b99ebb233f3888bb7ab65f07cf4ac82d";
function run(args: string[], input = "", env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...docker, ...args], { stdio: ["pipe", "pipe", "pipe"], env });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 2_000_000) child.kill(); });
    child.stderr.resume(); // Never print credentials/JWTs through command diagnostics.
    child.on("error", () => reject(Error("Owned transport command failed")));
    child.on("close", code => code === 0 ? resolve(output.trim()) : reject(Error(`Owned transport command exited ${code}`)));
    child.stdin.end(input);
  });
}
let stage = "guard";
const sql = (query: string) => run(["exec", "-i", database, "psql", "-XqAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], `SET statement_timeout='20s';SET lock_timeout='2s';${query}`);
async function main() {
  if (!process.argv.includes("--run-owned-fixture")) throw Error("Explicit owned-fixture flag required");
  const info = JSON.parse(await run(["inspect", database]))[0];
  assert.equal(info.Id, "603c10117cb7ef6a07d81448dd1a25b0c1ee2787a59f75871015c4a416cac557");
  assert.equal(info.HostConfig.NetworkMode, "none"); assert.equal(info.State.Running, true);
  assert.equal(await sql("SELECT marker FROM inbox_t2_fixture.identity"), "sandra-inbox-projection-t2-owned-synthetic");
  assert.equal(await sql("SHOW cron.launch_active_jobs"), "off");
  const role = `inbox_transport_${Date.now()}`, container = `${role}-api`, password = randomBytes(24).toString("hex"), secret = randomBytes(48).toString("hex");
  const org = randomUUID(), foreign = randomUUID(), user = randomUUID(), owner = randomUUID(), session = randomUUID(), target = randomUUID();
  let roleCreated = false, containerCreated = false;
  const checks: string[] = [], transportStatuses: number[] = [], denialCodes: string[] = [];
  try {
    stage = "create fixture login role";
    await sql(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' CONNECTION LIMIT 2;GRANT authenticated,anon TO ${role};`); roleCreated = true;
    stage = "create synthetic canonical rows";
    await sql(`INSERT INTO organizations(id,name) VALUES('${org}','Inbox JWT owned ${org}'),('${foreign}','Inbox JWT foreign ${foreign}');INSERT INTO auth.users(id,email) VALUES('${user}','${user}@example.test'),('${owner}','${owner}@example.test');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('${owner}','${org}','owner','active'),('${owner}','${foreign}','owner','active'),('${user}','${org}','member','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('${session}','${user}',clock_timestamp()+interval '1 hour');INSERT INTO inbox_t2_maintained.rows VALUES('${org}','known_conversation','${target}',1,1,'{"exists":true,"has_recent":true,"is_noise":false,"contact_name":"JWT synthetic","unread_count":1,"last_message_at":"2026-09-13T00:00:00Z"}',NULL);`);
    stage = "start isolated PostgREST";
    await run(["run", "-d", "--name", container, "--network", `container:${database}`, "--memory", "128m", "--cpus", "0.5", "--env", "PGRST_DB_URI", "--env", "PGRST_JWT_SECRET", "--env", "PGRST_DB_ANON_ROLE=anon", "--env", "PGRST_DB_SCHEMAS=public", "--env", "PGRST_DB_POOL=1", "--env", "PGRST_SERVER_HOST=127.0.0.1", "--env", "PGRST_SERVER_PORT=58792", image], "", { ...process.env, PGRST_DB_URI: `postgres://${role}:${password}@127.0.0.1:5432/postgres`, PGRST_JWT_SECRET: secret }); containerCreated = true;
    stage = "verify isolated PostgREST namespace";
    const apiInfo = JSON.parse(await run(["inspect", container]))[0];
    assert.equal(apiInfo.HostConfig.NetworkMode, `container:${info.Id}`); assert.deepEqual(apiInfo.HostConfig.PortBindings, {});
    stage = "PostgREST readiness";
    for (let attempt = 0; ; attempt++) {
      try { await run(["exec", database, "curl", "-fsS", "--max-time", "1", "http://127.0.0.1:58792/"]); break; }
      catch { if (attempt >= 30) throw Error("Owned PostgREST readiness failed"); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const sign = (expiry: number, key = secret) => {
      const encoded = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify({ sub: user, role: "authenticated", aud: "authenticated", session_id: session, exp: expiry })).toString("base64url")].join(".");
      return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
    };
    const namespaceFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, "http://inbox-fixture.invalid"); assert(url.pathname.startsWith("/rest/v1/rpc/"));
      const headers = new Headers(init?.headers);
      const quote = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r");
      const config = [`url = "http://127.0.0.1:58792${url.pathname.slice(8)}${url.search}"`, `request = "${init?.method ?? "POST"}"`, 'include', 'silent', 'show-error', 'max-time = 12', ...[...headers].map(([key, value]) => `header = "${quote(`${key}: ${value}`)}"`), `data = "${quote(String(init?.body ?? ""))}"`].join("\n");
      init?.signal?.throwIfAborted();
      const raw = await run(["exec", "-i", database, "curl", "--config", "-"], config);
      init?.signal?.throwIfAborted();
      const split = raw.indexOf("\r\n\r\n"), headerText = raw.slice(0, split), body = raw.slice(split + 4), status = Number(headerText.match(/^HTTP\/\S+ (\d+)/)?.[1]);
      assert(Number.isInteger(status)); transportStatuses.push(status);
      if (status === 401) { const denial = JSON.parse(body); if (typeof denial.code === "string") denialCodes.push(denial.code); }
      if (url.pathname.endsWith("inbox_create_workset_v2") && status === 200) {
        const data = JSON.parse(body);
        console.error(JSON.stringify({ diagnostic: "synthetic workset metadata", keys: Object.keys(data), handles: data.handles, targetCount: data.targets?.length, nextCursorType: typeof data.next_cursor, refreshedType: typeof data.refreshed, expiresAt: data.expires_at, hostNow: new Date().toISOString() }));
      }
      const responseHeaders = new Headers();
      for (const line of headerText.split("\r\n").slice(1)) { const colon = line.indexOf(":"); if (colon > 0) responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim()); }
      return new Response(body || null, { status, headers: responseHeaders });
    };
    const repository = (token: string) => {
      const cookie = `base64-${Buffer.from(JSON.stringify({ access_token: token, refresh_token: "owned-fixture-no-refresh", expires_at: Math.floor(Date.now()/1000)+3600, expires_in: 3600, token_type: "bearer", user: { id: user, aud: "authenticated" } })).toString("base64url")}`;
      const client = createServerClient("http://inbox-fixture.invalid", "owned-fixture-anon-key", { cookies: { getAll: () => [{ name: "sb-inbox-fixture-auth-token", value: cookie }], setAll: () => { throw Error("Unexpected refresh"); } }, global: { fetch: namespaceFetch } });
      return createSupabaseInboxRepository(client as unknown as InboxRpcClient);
    };
    const valid = repository(sign(Math.floor(Date.now()/1000)+3600)), signal = new AbortController().signal;
    stage = "cookie client JWT authorization";
    const actor = await valid.authenticate(new Request("http://inbox-fixture.invalid"), signal); assert(actor); assert.equal(actor.userId, user); checks.push("actual SSR cookie client to PostgREST JWT signature verification and canonical session authorization");
    stage = "workset HTTP core";
    const response = await createInboxWorksetHandler(valid)(new Request("http://inbox-fixture.invalid/api/inbox/worksets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: org, filter: { view: "all" }, cursor: null, limit: 100 }) }));
    if (response.status !== 201) console.error(JSON.stringify({ stage, responseStatus: response.status, transportStatuses }));
    assert.equal(response.status,201); const created = await response.json();
    if (created.orderedIds.length !== 1) console.error(JSON.stringify({ stage, rowCount: created.orderedIds.length }));
    assert.equal(created.orderedIds.length,1); assert.equal(created.orgId,org); checks.push("actual v2 workset HTTP core returns canonical typed membership");
    stage = "canonical counts";
    const counts = await valid.getCounts(actor, org, { view: "all" }, signal); assert.equal(counts.counts.all,1); checks.push("independent canonical counts over real authenticated RPC");
    for (const [label, token] of [["forged signature", sign(Math.floor(Date.now()/1000)+3600, randomBytes(48).toString("hex"))], ["expired JWT", sign(Math.floor(Date.now()/1000)-60)]]) {
      const before = transportStatuses.length;
      await assert.rejects(repository(token).authenticate(new Request("http://inbox-fixture.invalid"), signal));
      assert.equal(transportStatuses[before],401); checks.push(`${label} rejected by PostgREST before canonical RPC`);
    }
    await assert.rejects(valid.getAccess(actor, foreign, signal)); checks.push("cross organization denied by canonical wrapper");
    await sql(`UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id='${session}' AND user_id='${user}'`);
    await assert.rejects(valid.getScope(created.scopeId, signal)); checks.push("revoked canonical session rejects still cryptographically valid JWT");
  } finally {
    if (containerCreated) { await run(["rm", "-f", container]); containerCreated = false; }
    if (roleCreated) { await sql(`DROP ROLE ${role}`); roleCreated = false; }
  }
  const evidence = { passed: true, timestamp: new Date().toISOString(), sourceSha256: createHash("sha256").update(await readFile("experiments/inbox-jwt-transport-proof/run.ts")).digest("hex"), checks, transportStatuses, denialCodes, fixtures: { org, foreign, user, owner, session, target }, cleanup: { postgrestContainerRemoved: !containerCreated, loginRoleRemoved: !roleCreated }, limitations: ["Dedicated fixture SSR cookie adapter, not a running Next.js page", "Synthetic source rows retained in isolated T2 for evidence; no production data", "No production JWT or provider credentials used"] };
  await writeFile("experiments/inbox-jwt-transport-proof/evidence.json", JSON.stringify(evidence,null,2)+"\n"); console.log(JSON.stringify(evidence,null,2));
}
void main().catch(error => { console.error(`Owned JWT transport proof failed at ${stage}: ${error instanceof Error ? error.name : "unknown"}`); process.exitCode=1; });
