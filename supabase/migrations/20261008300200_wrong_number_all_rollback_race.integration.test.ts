import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261008300200 rollback vs a concurrent confirm. Needs committed data and
 * three real sessions, so it lives apart from the rolled-back-transaction tests.
 * Local-only, on a DB with the chain through 20261008300200 applied.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261008300200_wrong_number_all_confirm_suppresses.sql"), "utf8"),
);

describe("rollback vs a concurrent confirm (two sessions, committed data)", () => {
  it("the rollback waits for the in-flight confirm, then sees its obligation and refuses", async () => {
    const admin = new Client({ connectionString: url });
    const confirmer = new Client({ connectionString: url });
    const rolling = new Client({ connectionString: url });
    await Promise.all([admin.connect(), confirmer.connect(), rolling.connect()]);
    const org = randomUUID();
    const owner = randomUUID();
    const propertyId = randomUUID();
    const conv = randomUUID();
    const msg = randomUUID();
    const reviewId = randomUUID();
    try {
      await admin.query("insert into public.organizations (id, name) values ($1, 'wn-race')", [org]);
      await admin.query("set session_replication_role = replica");
      await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [owner, `race-${owner}@test.local`]);
      await admin.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [org, owner]);
      await admin.query(
        `insert into public.properties (id, org_id, address, state, status, outreach_dispo) values ($1, $2, 'Race St', 'TX', 'prospect', 'wrong_number')`,
        [propertyId, org],
      );
      await admin.query(
        `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body) values ($1, $2, $3, $4, 'sms', 'inbound', 'x')`,
        [msg, org, propertyId, conv],
      );
      await admin.query(
        `insert into public.ai_disposition_reviews (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, dispo_applied, wrong_scope)
         values ($1, $2, $3, $4, $5, 'wrong_number', 'x', 'pending', true, 'all')`,
        [reviewId, org, propertyId, conv, msg],
      );
      await admin.query("set session_replication_role = origin");

      // Session B: confirm in flight (uncommitted).
      await confirmer.query("begin");
      await confirmer.query("set local role authenticated");
      await confirmer.query("select set_config('request.jwt.claim.sub', $1, true)", [owner]);
      await confirmer.query("select public.fn_confirm_ai_disposition_review($1)", [reviewId]);

      // Session A: the rollback must wait on B, not read a stale pending/confirmed view.
      await rolling.query("begin");
      let settled = false;
      const rollbackRun = rolling.query(ROLLBACK).then(
        () => ((settled = true), null),
        (e: Error) => ((settled = true), e.message),
      );
      await new Promise((r) => setTimeout(r, 700));
      expect(settled).toBe(false);

      await confirmer.query("commit");
      const outcome = await rollbackRun;
      expect(outcome).toMatch(/ROLLBACK_REFUSED/);
      await rolling.query("rollback");
      const col = await admin.query(
        `select 1 from information_schema.columns where table_name = 'ai_disposition_reviews' and column_name = 'wrong_scope'`,
      );
      expect(col.rowCount).toBe(1);
    } finally {
      await confirmer.query("rollback").catch(() => {});
      await rolling.query("rollback").catch(() => {});
      await admin.query("set session_replication_role = replica").catch(() => {});
      await admin.query("delete from public.lead_events where org_id = $1", [org]).catch(() => {});
      await admin.query("delete from public.ai_disposition_reviews where org_id = $1", [org]).catch(() => {});
      await admin.query("delete from public.messages where org_id = $1", [org]).catch(() => {});
      await admin.query("delete from public.properties where org_id = $1", [org]).catch(() => {});
      await admin.query("delete from public.memberships where org_id = $1", [org]).catch(() => {});
      await admin.query("delete from auth.users where id = $1", [owner]).catch(() => {});
      await admin.query("delete from public.organizations where id = $1", [org]).catch(() => {});
      await Promise.all([admin.end(), confirmer.end(), rolling.end()]);
    }
  });
});
