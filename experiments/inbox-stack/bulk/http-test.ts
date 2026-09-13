import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pool, assertFixtureDatabase, USER_A } from "../shared/database.js";
await assertFixtureDatabase();
const endpoint = "http://127.0.0.1:58789/operations";
const headers = {
  "content-type": "application/json",
  "x-fixture-user": USER_A,
};
try {
  const malformed = await fetch(endpoint, {
    method: "POST",
    headers,
    body: '{"clientRequestId":',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /malformed JSON/);
  const unauthenticated = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthenticated.status, 401);
  const existing = (
    await pool.query(
      "SELECT id,command FROM inbox_t1.bulk_operations WHERE user_id=$1 AND state='completed' ORDER BY created_at LIMIT 1",
      [USER_A],
    )
  ).rows[0];
  assert.ok(existing, "Run bulk runtime harness first");
  const command = { ...existing.command };
  if (command.fault === null) delete command.fault;
  if (command.assignedUserId === null) delete command.assignedUserId;
  const before = (
    await pool.query("SELECT count(*) AS n FROM inbox_t1.property_write_audit")
  ).rows[0].n;
  const replay = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(command),
  });
  assert.equal(replay.status, 202);
  const receipt = await replay.json();
  assert.equal(receipt.operationId, existing.id);
  assert.equal(receipt.reused, true);
  const after = (
    await pool.query("SELECT count(*) AS n FROM inbox_t1.property_write_audit")
  ).rows[0].n;
  assert.equal(after, before);
  const rejected = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...command, unexpected: true }),
  });
  assert.equal(rejected.status, 400);
  const evidence = {
    at: new Date().toISOString(),
    passed: 4,
    checks: [
      "malformed JSON returns400",
      "missing identity returns401",
      "accepted command replay returns202 same operation without writes",
      "unknown command field returns400",
    ],
  };
  await writeFile(
    new URL("./http-evidence.json", import.meta.url),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await pool.end();
}
