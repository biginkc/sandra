import { randomUUID, createHash } from "node:crypto";
import { pool, assertFixtureDatabase } from "../shared/database.js";
export type Command = {
  clientRequestId: string;
  conversationIds: string[];
  outcome: string;
  assignedUserId?: string;
  fault?: "after_commit" | "between_steps";
};
export async function acceptOperation(user: string, input: Command) {
  await assertFixtureDatabase();
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(user)) throw Error("401 explicit fixture identity");
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some(
      (k) =>
        ![
          "clientRequestId",
          "conversationIds",
          "outcome",
          "assignedUserId",
          "fault",
        ].includes(k),
    ) ||
    typeof input.clientRequestId !== "string" ||
    input.clientRequestId.length < 1 ||
    input.clientRequestId.length > 128 ||
    !Array.isArray(input.conversationIds) ||
    !input.conversationIds.length ||
    input.conversationIds.length > 50 ||
    input.conversationIds.some(
      (id) => typeof id !== "string" || !uuid.test(id),
    ) ||
    typeof input.outcome !== "string" ||
    !input.outcome.trim() ||
    input.outcome.length > 100 ||
    (input.assignedUserId !== undefined && !uuid.test(input.assignedUserId)) ||
    (input.fault !== undefined &&
      !["after_commit", "between_steps"].includes(input.fault))
  )
    throw Error("400 invalid command");
  const command = {
    clientRequestId: input.clientRequestId,
    conversationIds: [...new Set(input.conversationIds)].sort(),
    outcome: input.outcome,
    assignedUserId: input.assignedUserId ?? null,
    fault: input.fault ?? null,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(command))
    .digest("hex");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const m = await c.query(
      "SELECT org_id FROM inbox_t1.memberships WHERE user_id=$1 AND active FOR SHARE",
      [user],
    );
    if (m.rowCount !== 1) throw Error("403 membership");
    const org = m.rows[0].org_id;
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      org + user + input.clientRequestId,
    ]);
    const existing = await c.query(
      "SELECT * FROM inbox_t1.bulk_operations WHERE org_id=$1 AND user_id=$2 AND request_key=$3",
      [org, user, input.clientRequestId],
    );
    if (existing.rowCount) {
      if (existing.rows[0].hash !== hash)
        throw Error("409 idempotency hash conflict");
      await c.query("COMMIT");
      return { operationId: existing.rows[0].id, reused: true };
    }
    if (command.assignedUserId) {
      const a = await c.query(
        "SELECT 1 FROM inbox_t1.memberships WHERE org_id=$1 AND user_id=$2 AND active",
        [org, command.assignedUserId],
      );
      if (!a.rowCount) throw Error("403 assignee");
    }
    const targets = await c.query(
      "SELECT s.conversation_id,p.id,p.revision FROM inbox_t1.conversation_summaries s JOIN inbox_t1.properties p ON p.org_id=s.org_id AND p.id=s.property_id WHERE s.org_id=$1 AND s.conversation_id=ANY($2::uuid[])",
      [org, command.conversationIds],
    );
    if (targets.rowCount !== command.conversationIds.length)
      throw Error("404 target");
    const id = randomUUID();
    await c.query(
      "INSERT INTO inbox_t1.bulk_operations(id,org_id,user_id,request_key,hash,command) VALUES($1,$2,$3,$4,$5,$6)",
      [id, org, user, input.clientRequestId, hash, command],
    );
    for (const t of new Map(targets.rows.map((x) => [x.id, x])).values())
      await c.query("INSERT INTO inbox_t1.bulk_targets VALUES($1,$2,$3)", [
        id,
        t.id,
        t.revision,
      ]);
    await c.query(
      "INSERT INTO inbox_t1.bulk_events(id,operation_id) VALUES($1,$2)",
      [randomUUID(), id],
    );
    await c.query("COMMIT");
    return {
      operationId: id,
      targetCount: new Set(targets.rows.map((x) => x.id)).size,
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function getOperation(user: string, id: string) {
  const q = await pool.query(
    "SELECT o.* FROM inbox_t1.bulk_operations o JOIN inbox_t1.memberships m ON m.org_id=o.org_id AND m.user_id=o.user_id AND m.active WHERE o.id=$1 AND o.user_id=$2",
    [id, user],
  );
  if (!q.rowCount) throw Error("404 operation");
  const receipts = await pool.query(
    "SELECT * FROM inbox_t1.bulk_receipts WHERE operation_id=$1 ORDER BY property_id,step",
    [id],
  );
  return { ...q.rows[0], receipts: receipts.rows };
}
export async function mutateStep(
  id: string,
  property: string,
  step: "outcome" | "assignment",
) {
  await assertFixtureDatabase();
  const c = await pool.connect();
  let crash = false;
  try {
    await c.query("BEGIN");
    const o = (
      await c.query(
        "SELECT * FROM inbox_t1.bulk_operations WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    const existing = await c.query(
      "SELECT * FROM inbox_t1.bulk_receipts WHERE operation_id=$1 AND property_id=$2 AND step=$3",
      [id, property, step],
    );
    if (existing.rowCount) {
      await c.query("COMMIT");
      return existing.rows[0];
    }
    if (!o) throw Error("404 operation");
    const m = await c.query(
      "SELECT 1 FROM inbox_t1.memberships WHERE org_id=$1 AND user_id=$2 AND active FOR SHARE",
      [o.org_id, o.user_id],
    );
    const t = (
      await c.query(
        "SELECT * FROM inbox_t1.bulk_targets WHERE operation_id=$1 AND property_id=$2 FOR UPDATE",
        [id, property],
      )
    ).rows[0];
    const p = (
      await c.query(
        "SELECT * FROM inbox_t1.properties WHERE org_id=$1 AND id=$2 FOR UPDATE",
        [o.org_id, property],
      )
    ).rows[0];
    if (!t || !p) throw Error("404 target");
    let state = m.rowCount ? "completed" : "revoked";
    if (step === "assignment") {
      const prev = await c.query(
        "SELECT state FROM inbox_t1.bulk_receipts WHERE operation_id=$1 AND property_id=$2 AND step='outcome'",
        [id, property],
      );
      if (prev.rows[0]?.state !== "completed") state = "skipped";
      if (o.command.assignedUserId) {
        const assignee = await c.query(
          "SELECT 1 FROM inbox_t1.memberships WHERE org_id=$1 AND user_id=$2 AND active FOR SHARE",
          [o.org_id, o.command.assignedUserId],
        );
        if (!assignee.rowCount) state = "revoked";
      }
    }
    if (state === "completed" && p.revision !== t.expected_revision)
      state = "conflict";
    let rev = p.revision;
    if (state === "completed") {
      const result =
        step === "outcome"
          ? await c.query(
              "UPDATE inbox_t1.properties SET outcome=$1 WHERE org_id=$2 AND id=$3 RETURNING revision",
              [o.command.outcome, o.org_id, property],
            )
          : await c.query(
              "UPDATE inbox_t1.properties SET assigned_user_id=$1 WHERE org_id=$2 AND id=$3 RETURNING revision",
              [o.command.assignedUserId ?? null, o.org_id, property],
            );
      rev = result.rows[0].revision;
      await c.query(
        "UPDATE inbox_t1.bulk_targets SET expected_revision=$3 WHERE operation_id=$1 AND property_id=$2",
        [id, property, rev],
      );
      await c.query("INSERT INTO inbox_t1.bulk_effects VALUES($1,$2,$3)", [
        id,
        property,
        step,
      ]);
    }
    await c.query("INSERT INTO inbox_t1.bulk_receipts VALUES($1,$2,$3,$4,$5)", [
      id,
      property,
      step,
      state,
      rev,
    ]);
    if (o.command.fault === "after_commit" && !o.fault_fired) {
      await c.query(
        "UPDATE inbox_t1.bulk_operations SET fault_fired=true WHERE id=$1",
        [id],
      );
      crash = true;
    }
    await c.query("COMMIT");
    if (crash) {
      process.kill(process.pid, "SIGKILL");
    }
    return { state, revision: rev };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
