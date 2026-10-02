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
        if (Object.keys(body).some(key => !allowed.has(key)) || body.email_confirm !== false || body.ban_duration !== "876000h" || body.email !== `inbox-ro-fixture@${emailDomain}`) {
          send(response, 400, { error: "password or unexpected fields supplied" });
          return;
        }
        await db.query(
          "insert into auth.users(id,email,email_confirmed_at,encrypted_password,banned_until,raw_app_meta_data) values ($1,$2,null,'',timestamptz '2101-01-01', $3::jsonb)",
          [body.id, body.email, JSON.stringify(body.app_metadata)],
        );
        send(response, 200, { user: { id: body.id, email: body.email, email_confirmed_at: null, banned_until: "2101-01-01T00:00:00.000Z", app_metadata: body.app_metadata } });
        return;
      }
      if (request.method === "GET" && pathname.startsWith("/auth/v1/admin/users/")) {
        const userId = decodeURIComponent(pathname.slice("/auth/v1/admin/users/".length));
        const result = await db.query("select id,email,email_confirmed_at,encrypted_password,banned_until,raw_app_meta_data from auth.users where id=$1", [userId]);
        if (!result.rowCount) {
          send(response, 404, { error: "user not found" });
          return;
        }
        const user = result.rows[0];
        send(response, 200, { user: { id: user.id, email: user.email, email_confirmed_at: user.email_confirmed_at, encrypted_password: user.encrypted_password, banned_until: user.banned_until, app_metadata: user.raw_app_meta_data } });
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
