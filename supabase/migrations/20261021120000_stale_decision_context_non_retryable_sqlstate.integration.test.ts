import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * 20261021120000: STALE_DECISION_CONTEXT must not use SQLSTATE 40001. PostgREST 14
 * retries 40001 forever, and the revision check is deterministic, so a stale call never
 * returned (prod, 2026-10-21: ~360k raises/hour). Proves, against a stack with the
 * migration applied: every raising function now uses JDC01, the message is unchanged,
 * a real stale call raises JDC01 with that message, and the rollback restores 40001.
 * Per-test transaction, rolled back. Isolated local stack only (vitest.local-integration.config.ts).
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const FUNCTIONS = [
  "fn_apply_ai_disposition_with_review",
  "fn_propose_deferred_ai_disposition_review",
  "fn_propose_jev_lead_decision",
  "fn_auto_apply_jev_lead_decision",
  "fn_propose_ai_dnc_suppression_review",
];
const rollbackSql = readFileSync(
  new URL("../rollbacks/20261021120000_stale_decision_context_non_retryable_sqlstate.sql", import.meta.url),
  "utf8",
);

let orgId: string;
let contactId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query("begin");
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
  orgId = randomUUID();
  contactId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Stale sqlstate ${orgId}`]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550002222', 'mobile')`,
    [contactId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function staleFixture() {
  const propertyId = randomUUID();
  const conversationId = randomUUID();
  const inboundId = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, homeowner_contact_id) values ($1, $2, 'Fixture St', 'TX', 'prospect', $3)`,
    [propertyId, orgId, contactId],
  );
  await db.query(
    `insert into public.message_threads (org_id, channel, contact_id, property_id, conversation_id) values ($1, 'sms', $2, $3, $4)`,
    [orgId, contactId, propertyId, conversationId],
  );
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
     values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'hi')`,
    [inboundId, orgId, propertyId, conversationId, contactId],
  );
  const { rows } = await db.query("select decision_context_revision from public.properties where id = $1", [propertyId]);
  return { propertyId, conversationId, inboundId, staleRevision: Number(rows[0].decision_context_revision) - 1 };
}

async function failure(sql: string, params: unknown[]) {
  await db.query("savepoint s");
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return error as { code?: string; message?: string };
  } finally {
    await db.query("rollback to savepoint s");
  }
}

describe("STALE_DECISION_CONTEXT SQLSTATE (20261021120000)", () => {
  it("every raising function uses JDC01, none uses 40001, message text unchanged", async () => {
    const { rows } = await db.query(
      `select p.proname, pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%STALE_DECISION_CONTEXT%'`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...FUNCTIONS].sort());
    for (const row of rows) {
      expect(row.def).toContain("raise exception 'STALE_DECISION_CONTEXT' using errcode = 'JDC01';");
      expect(row.def).not.toMatch(/'STALE_DECISION_CONTEXT' using errcode = '40001'/);
    }
  });

  it("fn_apply_ai_disposition_with_review (the hot path) raises JDC01, not a retryable class", async () => {
    const f = await staleFixture();
    const err = await failure(
      "select public.fn_apply_ai_disposition_with_review($1, $2, $3, 'not_interested', 'reason', $4)",
      [f.propertyId, f.conversationId, f.inboundId, f.staleRevision],
    );
    expect(err?.message).toBe("STALE_DECISION_CONTEXT");
    expect(err?.code).toBe("JDC01");
    expect(err?.code?.startsWith("40")).toBe(false);
  });

  it("fn_propose_jev_lead_decision raises JDC01 with the same message", async () => {
    const f = await staleFixture();
    const err = await failure(
      "select public.fn_propose_jev_lead_decision($1, $2, $3, $4, 'nurture', 0.5, 0.8, 1, $5)",
      [f.propertyId, f.conversationId, f.inboundId, randomUUID(), f.staleRevision],
    );
    expect(err).toMatchObject({ message: "STALE_DECISION_CONTEXT", code: "JDC01" });
  });

  it("the rollback restores 40001 on all five functions", async () => {
    await db.query("reset role");
    await db.query(rollbackSql.replace(/^[\s\S]*?\bbegin;\s*/i, "").replace(/\s*commit;\s*$/i, ""));
    const { rows } = await db.query(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and pg_get_functiondef(p.oid) like '%''STALE_DECISION_CONTEXT'' using errcode = ''40001''%'`,
    );
    expect(rows[0].n).toBe(FUNCTIONS.length);
  });
});
