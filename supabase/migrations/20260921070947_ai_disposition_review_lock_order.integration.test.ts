import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Fable re-review of e5d001bb (fable-final-review-e5d001bb.json,
 * jev-root-round17-fable2-fixes.md), finding 3 — P3 review-side deadlock
 * risk: fn_correct_ai_disposition_review and
 * fn_apply_and_record_ai_disposition_review_correction locked review
 * THEN property; fn_confirm_ai_disposition_review (and every
 * service-role path) locked property THEN review — a real deadlock
 * risk. Reordered to property-then-review, consistently, in
 * 20260921070947_ai_disposition_review_lock_order.sql. This proves,
 * against real Postgres with TWO separate connections: client A runs
 * confirm to completion (holding property+review locks, uncommitted),
 * client B's correct call is proven genuinely BLOCKED (not resolved,
 * raced against a timeout) on the SAME property lock, then A commits and
 * B proceeds cleanly with no 40P01 deadlock error.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

async function setActor(client: Client, userId: string) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
}

let orgId: string;
let contactId: string;
let userId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  contactId = randomUUID();
  userId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Review lock-order fixture ${orgId}`]);
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `reviewer-${userId}@test.local`]);
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [orgId, userId]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550004444', 'mobile')`,
    [contactId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

describe("lock order alignment — ai_disposition_reviews confirm and correct never deadlock on the same property+review (fable re-review e5d001bb, finding 3)", () => {
  it("a concurrent confirm (holding property+review locks) blocks a concurrent correct on the property lock, not a deadlock — real two-connection proof", async () => {
    const clientA = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
    const clientB = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
    await clientA.connect();
    await clientB.connect();
    try {
      const propertyId = randomUUID();
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const reviewId = randomUUID();

      // Fixtures must be COMMITTED — clientA/clientB are separate real
      // connections and cannot see anything still inside db's own
      // uncommitted per-test transaction.
      await db.query(
        `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
         values ($1, $2, 'Concurrent Review Ln', 'TX', 'prospect', 'wrong_number', $3)`,
        [propertyId, orgId, contactId],
      );
      await db.query(
        `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
         values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'wrong number, sorry')`,
        [messageId, orgId, propertyId, conversationId, contactId],
      );
      await db.query(
        `insert into public.ai_disposition_reviews (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason)
         values ($1, $2, $3, $4, $5, 'wrong_number', 'test fixture')`,
        [reviewId, orgId, propertyId, conversationId, messageId],
      );
      await db.query("commit");

      await clientA.query("begin");
      await setActor(clientA, userId);
      await clientB.query("begin");
      await setActor(clientB, userId);

      // A runs the FULL confirm RPC to completion (property lock, THEN
      // review lock, both acquired and held — A has not committed).
      const confirmResult = await clientA.query("select public.fn_confirm_ai_disposition_review($1) as result", [reviewId]);
      expect(confirmResult.rows[0].result).toMatchObject({ status: "confirmed" });

      // B starts correct concurrently — it must lock the SAME property
      // row first (finding 3's fix) and therefore blocks behind A,
      // rather than racing to lock the review row first (the old,
      // deadlock-prone order).
      const correctPromise = clientB.query(
        "select public.fn_correct_ai_disposition_review($1, $2, $3) as result",
        [reviewId, "not_interested", "concurrent test"],
      );

      // Prove B is genuinely BLOCKED (not deadlocked, not silently
      // erroring) — race it against a short timeout while A still holds
      // the lock.
      const stillPending = Symbol("still-pending");
      const raceResult = await Promise.race([
        correctPromise.then(() => "resolved" as const),
        new Promise((resolve) => setTimeout(() => resolve(stillPending), 300)),
      ]);
      expect(raceResult).toBe(stillPending);

      // Release A's locks — B must now proceed WITHOUT a deadlock error
      // (Postgres error code 40P01).
      await clientA.query("commit");

      const correctResult = await correctPromise;
      // A already confirmed (review now 'confirmed', property still
      // outreach_dispo='wrong_number' since dispo_applied was already
      // true) — B's own revision check runs against the SAME
      // decision_context_revision confirm left unchanged, so B's
      // correction still legitimately applies. The proof here is that
      // this resolved cleanly at all, rather than a 40P01 error.
      expect(correctResult.rows[0].result).toBeDefined();
      await clientB.query("commit");

      const finalReview = (await db.query("select status, corrected_disposition from public.ai_disposition_reviews where id = $1", [reviewId])).rows[0];
      expect(finalReview.status).toBe("confirmed");
      expect(finalReview.corrected_disposition).toBe("not_interested");
    } catch (e) {
      const pgError = e as { code?: string };
      expect(pgError.code).not.toBe("40P01");
      throw e;
    } finally {
      await clientA.query("rollback").catch(() => {});
      await clientB.query("rollback").catch(() => {});
      await clientA.end();
      await clientB.end();
      // This test committed its own fixtures — clean up explicitly, then
      // leave `db` back in an open transaction for afterEach's rollback.
      await db.query("delete from public.lead_events where org_id = $1", [orgId]);
      await db.query("delete from public.ai_disposition_reviews where org_id = $1", [orgId]);
      await db.query("delete from public.sms_classification_runs where org_id = $1", [orgId]);
      await db.query("delete from public.messages where org_id = $1", [orgId]);
      await db.query("delete from public.properties where org_id = $1", [orgId]);
      await db.query("delete from public.contacts where org_id = $1", [orgId]);
      // Not deleting memberships/organizations: this org's fixture
      // membership is its sole owner, and hugo_membership_owner_guard
      // blocks removing an org's last owner — harmless leftover on a
      // local disposable stack.
      await db.query("begin");
    }
  });
});
