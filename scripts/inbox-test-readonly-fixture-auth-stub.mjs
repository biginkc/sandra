#!/usr/bin/env node

import { createServer } from "node:http";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import pg from "pg";

const { Client } = pg;
const db = new Client({ connectionString: process.env.INBOX_RO_FIXTURE_AUTH_STUB_DB_URL });
const port = Number(process.env.INBOX_RO_FIXTURE_AUTH_STUB_PORT);
const readyFile = process.env.INBOX_RO_FIXTURE_AUTH_STUB_READY_FILE;
const emailDomain = process.env.INBOX_RO_FIXTURE_AUTH_STUB_EMAIL_DOMAIN;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function main() {
  await db.connect();
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "POST" && pathname === "/auth/v1/admin/users") {
        const body = JSON.parse(await readBody(request));
        const allowed = new Set(["app_metadata", "ban_duration", "email", "email_confirm", "id"]);
        if (Object.keys(body).some(key => !allowed.has(key)) || body.email_confirm !== false || body.ban_duration !== "876000h" || typeof body.email !== "string" || !body.email.endsWith(`@${emailDomain}`)) {
          send(response, 400, { error: "password or unexpected fields supplied" });
          return;
        }
        const appMetadata = { ...(body.app_metadata ?? {}), provider: "email", providers: ["email"] };
        const passwordHash = (await db.query("select crypt(gen_random_uuid()::text, gen_salt('bf', 10)) as value")).rows[0].value;
        await db.query(
          "insert into auth.users(id,email,email_confirmed_at,last_sign_in_at,encrypted_password,banned_until,raw_app_meta_data) values ($1,$2,null,null,$3,now() + interval '876000 hours',$4::jsonb)",
          [body.id, body.email, passwordHash, JSON.stringify(appMetadata)],
        );
        await db.query(
          "insert into auth.identities(id,provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at) values (gen_random_uuid(),$1::text,$2::uuid,$3::jsonb,'email',null,now(),now())",
          [body.id, body.id, JSON.stringify({ sub: body.id, email: body.email })],
        );
        const created = (await db.query("select id::text,email,email_confirmed_at,last_sign_in_at,banned_until,raw_app_meta_data from auth.users where id=$1", [body.id])).rows[0];
        const { raw_app_meta_data: rawAppMetadata, ...user } = created;
        send(response, 200, { user: { ...user, app_metadata: rawAppMetadata, provider: "email", providers: ["email"], identities: [{ provider: "email", identity_data: { sub: body.id, email: body.email } }] } });
        return;
      }
      if (request.method === "GET" && pathname.startsWith("/auth/v1/admin/users/")) {
        const userId = decodeURIComponent(pathname.slice("/auth/v1/admin/users/".length));
        const result = await db.query("select id,email,email_confirmed_at,last_sign_in_at,banned_until,raw_app_meta_data from auth.users where id=$1", [userId]);
        if (!result.rowCount) {
          send(response, 404, { error: "user not found" });
          return;
        }
        const user = result.rows[0];
        const identities = (await db.query("select provider,identity_data from auth.identities where user_id=$1 order by provider", [userId])).rows;
        send(response, 200, { user: { id: user.id, email: user.email, email_confirmed_at: user.email_confirmed_at, last_sign_in_at: user.last_sign_in_at, banned_until: user.banned_until, app_metadata: user.raw_app_meta_data, provider: "email", providers: ["email"], identities } });
        return;
      }
      send(response, 404, { error: "not found" });
    } catch {
      send(response, 500, { error: "local auth stub failure" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const readyTemp = `${readyFile}.tmp-${process.pid}`;
  writeFileSync(readyTemp, `${JSON.stringify({ port })}\n`, { mode: 0o600 });
  chmodSync(readyTemp, 0o600);
  renameSync(readyTemp, readyFile);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise(resolve => server.close(resolve));
    await db.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

main().catch(() => process.exit(1));
