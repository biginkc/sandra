import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  pool,
  assertFixtureDatabase,
  USER_A,
  USER_B,
  ORG_A,
} from "../shared/database.js";
import { acceptOperation, getOperation } from "./domain.js";
import { relayOnce } from "./relay.js";
await assertFixtureDatabase();
const checks: { name: string; passed: boolean }[] = [];
const record = (name: string) => checks.push({ name, passed: true });
const conversations = (
  await pool.query(
    "SELECT conversation_id,property_id FROM inbox_t1.conversation_summaries WHERE org_id=$1 ORDER BY latest_message_at DESC",
    [ORG_A],
  )
).rows;
const base = (i: number) => ({
  clientRequestId: randomUUID(),
  conversationIds: [conversations[i].conversation_id],
  outcome: "t1-" + randomUUID(),
  assignedUserId: USER_A,
});
const audit = async (p: string) =>
  Number(
    (
      await pool.query(
        "SELECT count(*) FROM inbox_t1.property_write_audit WHERE property_id=$1",
        [p],
      )
    ).rows[0].count,
  );
async function wait(id: string, state?: string) {
  for (let n = 0; n < 100; n++) {
    const o = await getOperation(USER_A, id);
    if (state ? o.state === state : o.state !== "accepted") return o;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("timeout " + id);
}
let worker = spawn(process.execPath, ["--import", "tsx", "bulk/worker.ts"], {
  stdio: "ignore",
});
try {
  await new Promise((r) => setTimeout(r, 500));
  await assert.rejects(() => acceptOperation("", base(1)));
  record("missing identity denied");
  await assert.rejects(
    () => acceptOperation(USER_B, { ...base(1), assignedUserId: USER_B }),
    /404/,
  );
  record("cross tenant targets denied");
  const cmd = {
    ...base(0),
    conversationIds: [
      conversations[0].conversation_id,
      conversations[499].conversation_id,
    ],
  };
  const a0 = await audit(conversations[0].property_id);
  const op = await acceptOperation(USER_A, cmd);
  assert.equal(op.targetCount, 1);
  const again = await acceptOperation(USER_A, cmd);
  assert.equal(again.operationId, op.operationId);
  await assert.rejects(
    () => acceptOperation(USER_A, { ...cmd, outcome: "other" }),
    /409/,
  );
  record("property deduplication and request hash conflict");
  const lost = await relayOnce(true);
  await new Promise((r) => setTimeout(r, 2100));
  const redelivered = await relayOnce();
  assert.equal(lost.invocationId, redelivered.invocationId);
  const result = await wait(op.operationId);
  assert.equal(result.receipts.length, 2);
  assert.equal((await audit(conversations[0].property_id)) - a0, 2);
  record(
    "lost relay acknowledgement same invocation and exactly two canonical writes",
  );
  const b = base(1);
  const before = await audit(conversations[1].property_id);
  const fault = await acceptOperation(USER_A, { ...b, fault: "after_commit" });
  await relayOnce();
  await new Promise<void>((resolve, reject) => {
    if (worker.exitCode !== null || worker.signalCode) return resolve();
    worker.once("exit", () => resolve());
    setTimeout(() => reject(Error("worker did not crash")), 10000).unref();
  });
  worker = spawn(process.execPath, ["--import", "tsx", "bulk/worker.ts"], {
    stdio: "ignore",
  });
  await wait(fault.operationId);
  assert.equal((await audit(conversations[1].property_id)) - before, 2);
  record(
    "SIGKILL after canonical commit before journal acknowledgement resumes without duplicate update",
  );
  const c = base(2);
  const before2 = await audit(conversations[2].property_id);
  const transient = await acceptOperation(USER_A, {
    ...c,
    fault: "between_steps",
  });
  await relayOnce();
  await wait(transient.operationId);
  assert.equal((await audit(conversations[2].property_id)) - before2, 2);
  record("between-step failure retries without reapplying outcome");
  const revoked = await acceptOperation(USER_A, base(3));
  const before3 = await audit(conversations[3].property_id);
  await pool.query(
    "UPDATE inbox_t1.memberships SET active=false WHERE org_id=$1 AND user_id=$2",
    [ORG_A, USER_A],
  );
  await relayOnce();
  for (let n = 0; n < 50; n++) {
    const q = await pool.query(
      "SELECT state FROM inbox_t1.bulk_operations WHERE id=$1",
      [revoked.operationId],
    );
    if (q.rows[0].state !== "accepted") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(await audit(conversations[3].property_id), before3);
  await assert.rejects(() => getOperation(USER_A, revoked.operationId), /404/);
  await pool.query(
    "UPDATE inbox_t1.memberships SET active=true WHERE org_id=$1 AND user_id=$2",
    [ORG_A, USER_A],
  );
  const r = await getOperation(USER_A, revoked.operationId);
  assert.equal(r.state, "partial");
  assert.ok(r.receipts.some((x: any) => x.state === "revoked"));
  record("execution membership revocation blocks writes and receipt access");
  const conflict = await acceptOperation(USER_A, base(4));
  await pool.query(
    "UPDATE inbox_t1.properties SET outcome='external fixture edit' WHERE org_id=$1 AND id=$2",
    [ORG_A, conversations[4].property_id],
  );
  const before4 = await audit(conversations[4].property_id);
  await relayOnce();
  const conflictResult = await wait(conflict.operationId);
  assert.equal(conflictResult.state, "partial");
  assert.equal(await audit(conversations[4].property_id), before4);
  record(
    "authoritative revision conflict does not overwrite concurrent writer",
  );
  await writeFile(
    new URL("./evidence.json", import.meta.url),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        runtime: "1.7.5",
        sdk: "1.17.0",
        imageDigest:
          "sha256:675b85e7bf674f9dfda04a391fa33e850650d57e464b694ca8df5866acad95cc",
        checks,
        limits: [
          "synthetic local DB only",
          "no provider sends",
          "single worker and sequential target executor",
          "no production load or HA validation",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally {
  worker.kill("SIGTERM");
  await pool.query(
    "UPDATE inbox_t1.memberships SET active=true WHERE org_id=$1 AND user_id=$2",
    [ORG_A, USER_A],
  );
  await pool.end();
}
