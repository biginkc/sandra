#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const root = decodeURIComponent(new URL("../..", import.meta.url).pathname);
const pgHost = process.env.PROJECTION_PGHOST ?? process.env.PGHOST;
const pgPort = process.env.PROJECTION_PGPORT ?? process.env.PGPORT ?? "5432";
if (!pgHost) throw new Error("PROJECTION_PGHOST is required");

const postgrestPort = Number(process.env.LOCAL_POSTGREST_PORT ?? "55438");
const proxyPort = Number(process.env.LOCAL_SUPABASE_PROXY_PORT ?? "55439");
const jwtSecret = "reply-persistence-r3-local-jwt-secret-32-bytes";

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function serviceRoleJwt() {
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const payload = base64url({
    role: "postgres",
    sub: "00000000-0000-0000-0000-000000000001",
    iss: "supabase",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", jwtSecret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function directDbUrl() {
  return `postgres://postgres@localhost:${pgPort}/postgres?host=${encodeURIComponent(pgHost)}`;
}

async function waitFor(url) {
  const deadline = Date.now() + 15000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`local PostgREST did not become ready: ${lastError}`);
}

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function startProxy() {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/storage/v1/")) {
      json(response, 404, { message: "Bucket not found" });
      return;
    }
    if (request.url?.startsWith("/auth/v1/admin/users")) {
      json(response, 200, { users: [] });
      return;
    }
    if (!request.url?.startsWith("/rest/v1/")) {
      json(response, 404, { message: "Not found" });
      return;
    }
    const upstreamPath = request.url.replace(/^\/rest\/v1/, "") || "/";
    const upstream = fetch(`http://127.0.0.1:${postgrestPort}${upstreamPath}`, {
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${postgrestPort}` },
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
      duplex: "half",
    });
    upstream.then(async (result) => {
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    }).catch((error) => {
      json(response, 502, { message: error instanceof Error ? error.message : String(error) });
    });
  });
  return new Promise((resolve) => server.listen(proxyPort, "127.0.0.1", () => resolve(server)));
}

async function seedLocalOrganizations() {
  const child = spawn(
    "psql",
    [
      "-XqAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      pgHost,
      "-p",
      pgPort,
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      `insert into organizations(id, name) values
        ('00000000-0000-0000-0000-000000000001', 'Local reply persistence'),
        ('00000000-0000-0000-0000-000000000bbb', 'BMH Group')
        on conflict (id) do nothing;
       insert into auth.users(id, email, aud, role)
       values ('00000000-0000-0000-0000-000000000001', 'local-reply-persist@example.test', 'authenticated', 'authenticated')
       on conflict (id) do nothing;
       set session_replication_role = 'replica';
       delete from memberships where user_id = '00000000-0000-0000-0000-000000000001';
       set session_replication_role = 'origin';
       `,
    ],
    { cwd: root, stdio: "inherit" },
  );
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) throw new Error(`local organization seed failed (${status})`);
}

async function runPsql(sql) {
  const child = spawn(
    "psql",
    ["-XqAt", "-v", "ON_ERROR_STOP=1", "-h", pgHost, "-p", pgPort, "-U", "postgres", "-d", "postgres"],
    { cwd: root, stdio: ["pipe", "inherit", "inherit"] },
  );
  child.stdin.end(sql);
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) throw new Error(`local SQL mutation failed (${status})`);
}

async function queryPsql(sql) {
  const child = spawn(
    "psql",
    ["-XqAt", "-v", "ON_ERROR_STOP=1", "-h", pgHost, "-p", pgPort, "-U", "postgres", "-d", "postgres"],
    { cwd: root, stdio: ["pipe", "pipe", "inherit"] },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(sql);
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) throw new Error(`local SQL query failed (${status})`);
  return output.trim();
}

function projectionFunction(mutated) {
  const migration = readFileSync(
    `${root}/supabase/migrations/20260930040250_inbox_reply_message_projection.sql`,
    "utf8",
  );
  const start = migration.indexOf("CREATE FUNCTION inbox_reply_send.project_message(");
  const end = migration.indexOf("END $$;", start) + "END $$;".length;
  if (start < 0 || end < start) throw new Error("project_message function not found");
  let body = migration.slice(start, end).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
  if (mutated) {
    const needle = " projected_metadata:=jsonb_build_object('inboxReply',marker);";
    const replacement = " projected_metadata:=jsonb_build_object('inboxReply',marker,'generated_by','reply');";
    if (!body.includes(needle)) throw new Error("T23 SQL mutation target not found");
    body = body.replace(needle, replacement);
  }
  return body;
}

function testCommand(test) {
  if (test === "T18") {
    return [
      "src/app/api/cron/sequence-tick/route.queue.integration.test.ts",
      "T18 leaves a pending Inbox reply pending after the sixteen-minute sweep window",
    ];
  }
  if (test === "T23") {
    return [
      "src/app/(dashboard)/leads/actions.integration.test.ts",
      "T23 uses the real sendSmsFromLead path for pending and accepted default-sender stages",
    ];
  }
  throw new Error(`unknown local integration test ${test}`);
}

async function runTest(test, env) {
  const [file, title] = testCommand(test);
  const child = spawn(
    "npx",
    ["vitest", "run", "--config", "vitest.integration.config.ts", file, "-t", title, "--pool=threads", "--maxWorkers=1", "--no-file-parallelism"],
    { cwd: root, env, stdio: "inherit" },
  );
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) throw new Error(`local integration test failed (${status ?? "unknown"})`);
}

const requested = process.argv.slice(2).flatMap((arg, index, args) =>
  arg === "--test" ? [args[index + 1]] : [],
).filter(Boolean);
const tests = requested.length > 0 ? requested : ["T18", "T23"];
const mutationIndex = process.argv.indexOf("--mutated");
const mutation = mutationIndex >= 0 ? process.argv[mutationIndex + 1] : null;
await seedLocalOrganizations();
if (mutation === "T23") {
  await runPsql(projectionFunction(true));
  const installed = await queryPsql(
    "select pg_get_functiondef('inbox_reply_send.project_message(uuid,uuid)'::regprocedure) like '%generated_by%';",
  );
  if (installed !== "t") throw new Error("T23 SQL mutation was not installed");
}
const postgrest = spawn("postgrest", [], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PGRST_DB_URI: directDbUrl(),
    PGRST_DB_ANON_ROLE: "postgres",
    PGRST_DB_SCHEMAS: "public",
    PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
    PGRST_JWT_SECRET: jwtSecret,
    PGRST_SERVER_PORT: String(postgrestPort),
  },
});
const proxy = await startProxy();
try {
  await waitFor(`http://127.0.0.1:${postgrestPort}/`);
  const jwt = serviceRoleJwt();
  const env = {
    ...process.env,
    TEST_SUPABASE_URL: `http://127.0.0.1:${proxyPort}`,
    TEST_SUPABASE_ANON_KEY: jwt,
    TEST_SUPABASE_SERVICE_ROLE_KEY: jwt,
    TEST_SUPABASE_DB_URL: directDbUrl(),
  };
  for (const test of tests) await runTest(test, env);
} finally {
  await new Promise((resolve) => proxy.close(resolve));
  if (postgrest.exitCode === null) postgrest.kill("SIGTERM");
  if (mutation === "T23") await runPsql(projectionFunction(false));
}
