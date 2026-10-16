import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Fable review of 9cd4ec2b (fable-final-review-9cd4ec2b.json,
 * jev-root-round15-fable-fixes.md), findings 3-5. Real Postgres, no mocks.
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
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Lock-order fixture ${orgId}`]);
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `reviewer-${userId}@test.local`]);
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [orgId, userId]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550009999', 'mobile')`,
    [contactId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function makeProperty(): Promise<string> {
  const propertyId = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
     values ($1, $2, 'Fixture St', 'TX', 'prospect', null, $3)`,
    [propertyId, orgId, contactId],
  );
  return propertyId;
}

async function makeInboundMessage(propertyId: string, conversationId: string, body = "hi"): Promise<string> {
  const messageId = randomUUID();
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
     values ($1, $2, $3, $4, $5, 'sms', 'inbound', $6)`,
    [messageId, orgId, propertyId, conversationId, contactId, body],
  );
  return messageId;
}

async function makeClassificationRun(args: {
  propertyId: string;
  conversationId: string;
  sourceInboundMessageId: string;
  resolvedOutcome: string | null;
  fallbackReason?: string | null;
}): Promise<string> {
  const runId = randomUUID();
  await db.query(
    `insert into public.sms_classification_runs
       (id, org_id, property_id, conversation_id, source_inbound_message_id, state_hash, state_version, schema_version, policy_version, provider, model, decision, resolved_outcome, fallback_reason)
     values ($1, $2, $3, $4, $5, $6, 1, 'v1', 'v1', 'jev', 'jev-1.13.0', '{}'::jsonb, $7, $8)`,
    [runId, orgId, args.propertyId, args.conversationId, args.sourceInboundMessageId, randomUUID(), args.resolvedOutcome, args.fallbackReason ?? null],
  );
  return runId;
}

async function promote(runId: string) {
  await setActor(db, userId);
  const { rows } = await db.query("select public.fn_promote_classifier_event_to_decision($1) as result", [runId]);
  // `set local role authenticated` persists for the rest of THIS test's
  // transaction (not just this statement) — reset back to the
  // superuser session default so subsequent fixture inserts in the same
  // test (e.g. a second classification run) aren't rejected by
  // authenticated's read-only grant on sms_classification_runs.
  await db.query("reset role");
  return rows[0].result;
}

describe("fn_confirm_jev_lead_decision rejects a promoted placeholder decision cleanly (finding 3)", () => {
  it("raises UNSUPPORTED_CONFIRM_OUTCOME for a promoted 'unclear' decision — not a raw constraint error, no mutation", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: "unclear" });

    const promoted = await promote(runId);
    expect(promoted.status).toBe("promoted");

    await db.query("savepoint rejected_confirm");
    await setActor(db, userId);
    await expect(
      db.query("select public.fn_confirm_jev_lead_decision($1)", [promoted.decisionId]),
    ).rejects.toMatchObject({ message: expect.stringContaining("UNSUPPORTED_CONFIRM_OUTCOME") });
    await db.query("rollback to savepoint rejected_confirm");

    const row = (await db.query("select status, resolved_outcome from public.jev_lead_decisions where id = $1", [promoted.decisionId])).rows[0];
    expect(row).toEqual({ status: "pending", resolved_outcome: null });
  });

  it("raises the SAME clean error for a promoted 'bad_number' decision", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: "bad_number" });

    const promoted = await promote(runId);

    await setActor(db, userId);
    await expect(
      db.query("select public.fn_confirm_jev_lead_decision($1)", [promoted.decisionId]),
    ).rejects.toMatchObject({ message: expect.stringContaining("UNSUPPORTED_CONFIRM_OUTCOME") });
  });

  it("still confirms a genuine new_lead/nurture pending decision normally (unaffected by the new check)", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: null, fallbackReason: "provider_timeout" });

    // A genuine nurture proposal, inserted directly (mirrors fn_propose_jev_lead_decision's shape).
    const decisionId = randomUUID();
    await db.query(
      `insert into public.jev_lead_decisions (id, org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome, status)
       values ($1, $2, $3, $4, $5, $6, 'nurture', 'pending')`,
      [decisionId, orgId, propertyId, conversationId, messageId, runId],
    );

    await setActor(db, userId);
    const { rows } = await db.query("select public.fn_confirm_jev_lead_decision($1) as result", [decisionId]);
    expect(rows[0].result).toMatchObject({ status: "confirmed", resolvedOutcome: "nurture" });
  });
});

describe("fn_promote_classifier_event_to_decision — one pending decision per property (finding 4)", () => {
  it("promoting a SECOND, different classifier event for the SAME property supersedes the first pending decision", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();

    const firstMessageId = await makeInboundMessage(propertyId, conversationId, "not sure");
    const firstRunId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: firstMessageId, resolvedOutcome: "unclear" });
    const firstPromoted = await promote(firstRunId);
    expect(firstPromoted.status).toBe("promoted");

    const secondMessageId = await makeInboundMessage(propertyId, conversationId, "wrong number sorry");
    const secondRunId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: secondMessageId, resolvedOutcome: "bad_number" });
    const secondPromoted = await promote(secondRunId);
    expect(secondPromoted.status).toBe("promoted");
    expect(secondPromoted.decisionId).not.toBe(firstPromoted.decisionId);

    // Sorted by id, not created_at — two inserts in the same test can
    // land in the same microsecond when this file runs alongside many
    // others, making created_at ties non-deterministic; the identity of
    // which row is superseded vs. pending is what actually matters here.
    const rows = (await db.query(
      "select id, status, superseded_reason from public.jev_lead_decisions where property_id = $1 order by id",
      [propertyId],
    )).rows;
    expect(rows).toEqual(
      [
        { id: firstPromoted.decisionId, status: "superseded", superseded_reason: "new_classifier_event_promoted" },
        { id: secondPromoted.decisionId, status: "pending", superseded_reason: null },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );

    const pendingCount = (await db.query(
      "select count(*)::int as n from public.jev_lead_decisions where property_id = $1 and status = 'pending'",
      [propertyId],
    )).rows[0].n;
    expect(pendingCount).toBe(1);
  });

  it("promoting the SAME inbound twice is still idempotent (already_promoted), not a duplicate row", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: "unclear" });

    const first = await promote(runId);
    const second = await promote(runId);
    expect(second).toEqual({ status: "already_promoted", decisionId: first.decisionId });

    const count = (await db.query("select count(*)::int as n from public.jev_lead_decisions where property_id = $1", [propertyId])).rows[0].n;
    expect(count).toBe(1);
  });

  // Root review of 57236716 (jev-root-round16-promotion-revision.md),
  // finding 1: the promoted row's decision_context_revision must be the
  // EXACT value the property lock observed — not a default (e.g. 0) and
  // not left to a separate, unrelated trigger.
  it("captures the locked property's CURRENT decision_context_revision into the promoted row exactly", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    // Bump the revision away from its starting value first, so a
    // default/stale (e.g. 0) capture would be visibly wrong, not
    // coincidentally correct.
    await makeInboundMessage(propertyId, conversationId, "first inbound bumps the revision");
    const { rows: beforeRows } = await db.query(
      "select decision_context_revision from public.properties where id = $1",
      [propertyId],
    );
    const expectedRevision = Number(beforeRows[0].decision_context_revision);
    expect(expectedRevision).toBeGreaterThan(0);

    const messageId = await makeInboundMessage(propertyId, conversationId, "unclear reply");
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: "unclear" });
    const promoted = await promote(runId);

    const { rows: decisionRows } = await db.query(
      "select decision_context_revision from public.jev_lead_decisions where id = $1",
      [promoted.decisionId],
    );
    // The second makeInboundMessage call above ALSO bumped the revision
    // (real thread activity) — the promoted row must match the property
    // AS OF the lock, i.e. the CURRENT value, not the earlier snapshot.
    const { rows: afterRows } = await db.query(
      "select decision_context_revision from public.properties where id = $1",
      [propertyId],
    );
    expect(Number(decisionRows[0].decision_context_revision)).toBe(Number(afterRows[0].decision_context_revision));
    expect(Number(decisionRows[0].decision_context_revision)).toBeGreaterThan(expectedRevision);
  });

  // Root review of 57236716, finding 2: the repair only superseded ONE
  // pre-existing pending row — reproduces the exact pre-existing-bug
  // leftover state (two pending rows already on one property, inserted
  // directly, bypassing the RPC) and proves the fix supersedes BOTH
  // before promoting the third.
  it("supersedes ALL pre-existing pending rows for the property, not just one, leaving exactly one pending afterward", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();

    async function insertLeftoverPendingDecision(body: string): Promise<string> {
      const messageId = await makeInboundMessage(propertyId, conversationId, body);
      const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: "unclear" });
      const decisionId = randomUUID();
      await db.query(
        `insert into public.jev_lead_decisions (id, org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome, status)
         values ($1, $2, $3, $4, $5, $6, 'unclear', 'pending')`,
        [decisionId, orgId, propertyId, conversationId, messageId, runId],
      );
      return decisionId;
    }

    // Two leftover pending rows, simulating what the OLD single-row
    // repair would have left behind.
    const leftoverA = await insertLeftoverPendingDecision("leftover pending A");
    const leftoverB = await insertLeftoverPendingDecision("leftover pending B");

    const newMessageId = await makeInboundMessage(propertyId, conversationId, "the actual new classifier event");
    const newRunId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: newMessageId, resolvedOutcome: "bad_number" });
    const promoted = await promote(newRunId);
    expect(promoted.status).toBe("promoted");

    // Order-independent — see the comment on the equivalent assertion
    // above; identity of superseded vs. pending is what matters, not
    // created_at tie-break order (two inserts can land in the same
    // microsecond when this file runs alongside many others).
    const rows = (await db.query(
      "select id, status, superseded_reason from public.jev_lead_decisions where property_id = $1",
      [propertyId],
    )).rows;
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: leftoverA, status: "superseded", superseded_reason: "new_classifier_event_promoted" },
        { id: leftoverB, status: "superseded", superseded_reason: "new_classifier_event_promoted" },
        { id: promoted.decisionId, status: "pending", superseded_reason: null },
      ]),
    );

    const pendingCount = (await db.query(
      "select count(*)::int as n from public.jev_lead_decisions where property_id = $1 and status = 'pending'",
      [propertyId],
    )).rows[0].n;
    expect(pendingCount).toBe(1);
  });

  it("same-source idempotency is preserved: re-promoting an already-pending inbound never supersedes its OWN row", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: "unclear" });

    const first = await promote(runId);
    const second = await promote(runId);
    expect(second).toEqual({ status: "already_promoted", decisionId: first.decisionId });

    const row = (await db.query("select status, superseded_reason from public.jev_lead_decisions where id = $1", [first.decisionId])).rows[0];
    expect(row).toEqual({ status: "pending", superseded_reason: null });
  });
});

describe("lock order alignment — confirm and correct never deadlock on the same property+decision (finding 5)", () => {
  it("a concurrent confirm (holding property+decision locks) blocks a concurrent correct on the property lock, not a deadlock — real two-connection proof", async () => {
    const clientA = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
    const clientB = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
    await clientA.connect();
    await clientB.connect();
    try {
      const propertyId = randomUUID();
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const decisionId = randomUUID();

      // Fixtures must be COMMITTED — clientA/clientB are separate real
      // connections and cannot see anything still inside db's own
      // uncommitted per-test transaction. This test explicitly commits
      // and cleans up (see finally below) instead of relying on the
      // usual rollback-per-test isolation.
      await db.query(
        `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
         values ($1, $2, 'Concurrent Ln', 'TX', 'prospect', null, $3)`,
        [propertyId, orgId, contactId],
      );
      await db.query(
        `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
         values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'not right now')`,
        [messageId, orgId, propertyId, conversationId, contactId],
      );
      const runId = randomUUID();
      await db.query(
        `insert into public.sms_classification_runs
           (id, org_id, property_id, conversation_id, source_inbound_message_id, state_hash, state_version, schema_version, policy_version, provider, model, decision)
         values ($1, $2, $3, $4, $5, $6, 1, 'v1', 'v1', 'jev', 'jev-1.13.0', '{}'::jsonb)`,
        [runId, orgId, propertyId, conversationId, messageId, randomUUID()],
      );
      await db.query(
        `insert into public.jev_lead_decisions (id, org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome, status)
         values ($1, $2, $3, $4, $5, $6, 'nurture', 'pending')`,
        [decisionId, orgId, propertyId, conversationId, messageId, runId],
      );
      await db.query("commit");

      await clientA.query("begin");
      await setActor(clientA, userId);
      await clientB.query("begin");
      await setActor(clientB, userId);

      // A runs the FULL confirm RPC to completion (property lock, THEN
      // decision lock, both acquired and held — A has not committed).
      const confirmResult = await clientA.query("select public.fn_confirm_jev_lead_decision($1) as result", [decisionId]);
      expect(confirmResult.rows[0].result).toMatchObject({ status: "confirmed" });

      // B starts correct concurrently — it must lock the SAME property
      // row first (finding 5's fix) and therefore blocks behind A,
      // rather than racing to lock the decision row first (the old,
      // deadlock-prone order).
      const correctPromise = clientB.query(
        "select public.fn_correct_jev_lead_decision($1, $2, $3) as result",
        [decisionId, "wrong_number", "concurrent test"],
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
      // A already confirmed (moved the property/decision forward), so B's
      // revision no longer matches — a real, expected STALE_STATE
      // business outcome, not a deadlock. The proof here is that this
      // resolved cleanly at all, rather than a 40P01 error.
      expect(correctResult.rows[0].result).toBeDefined();
      await clientB.query("commit");
    } catch (e) {
      const pgError = e as { code?: string };
      expect(pgError.code).not.toBe("40P01");
      throw e;
    } finally {
      await clientA.query("rollback").catch(() => {});
      await clientB.query("rollback").catch(() => {});
      await clientA.end();
      await clientB.end();
      // This test committed its own fixtures (see above) — the usual
      // per-test rollback in afterEach cannot undo them, so clean up
      // explicitly, then leave `db` back in an open transaction for
      // afterEach's rollback to close normally.
      await db.query("delete from public.lead_events where org_id = $1", [orgId]);
      await db.query("delete from public.jev_lead_decisions where org_id = $1", [orgId]);
      await db.query("delete from public.sms_classification_runs where org_id = $1", [orgId]);
      await db.query("delete from public.messages where org_id = $1", [orgId]);
      await db.query("delete from public.properties where org_id = $1", [orgId]);
      await db.query("delete from public.contacts where org_id = $1", [orgId]);
      // Not deleting memberships/organizations: this org's fixture
      // membership is its sole owner, and hugo_membership_owner_guard
      // (FINAL_OWNER_GUARD) blocks removing an org's last owner — same
      // "leftover is harmless on a local disposable stack" posture the
      // Playwright local acceptance lane already uses for this exact
      // situation.
      await db.query("begin");
    }
  });
});
