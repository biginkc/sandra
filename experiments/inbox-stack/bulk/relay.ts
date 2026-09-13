import { pool } from "../shared/database.js";
export async function relayOnce(ignoreAcknowledgement = false) {
  const c = await pool.connect();
  let event;
  try {
    await c.query("BEGIN");
    const q = await c.query(
      "SELECT * FROM inbox_t1.bulk_events WHERE NOT delivered AND (lease_until IS NULL OR lease_until<now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!q.rowCount) {
      await c.query("COMMIT");
      return null;
    }
    event = q.rows[0];
    const claim = await c.query(
      "UPDATE inbox_t1.bulk_events SET generation=generation+1,lease_until=now()+interval '2 seconds' WHERE id=$1 RETURNING generation",
      [event.id],
    );
    event.generation = claim.rows[0].generation;
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  const response = await fetch(
    "http://127.0.0.1:58785/InboxOperation/run/send",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `inbox:${event.id}`,
      },
      body: JSON.stringify({ operationId: event.operation_id }),
    },
  );
  if (!response.ok) throw Error("runtime acceptance " + response.status);
  const accepted = await response.json();
  if (!ignoreAcknowledgement)
    await pool.query(
      "UPDATE inbox_t1.bulk_events SET delivered=true,invocation_id=$3 WHERE id=$1 AND generation=$2",
      [event.id, event.generation, accepted.invocationId],
    );
  return { eventId: event.id, ...accepted };
}
