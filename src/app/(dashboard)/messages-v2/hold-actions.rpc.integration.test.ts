import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ok } from "@/lib/errors/result";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { SEND_LEASE_SECONDS, withPropertyLease, type HoldActionDeps } from "./hold-actions";

/**
 * The hold send lease calls fn_reserve_ai_send through a real PostgREST with
 * the exact arguments hold-actions.ts sends. A mocked client cannot catch a
 * signature mismatch (the function requires p_inbound_message_id with no
 * default; omitting it is PGRST202 -> SEND_BUSY on every Send). Local-only.
 *
 * If the local database has not been migrated that far, the table and the two
 * functions are created from the committed migration and dropped afterwards.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
let createdSchema = false;

beforeAll(async () => {
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  await db.connect();
  const { rows } = await db.query("select to_regproc('public.fn_reserve_ai_send') as f");
  if (!rows[0].f) {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20261008143300_messages_v2_send_reservation.sql"),
      "utf8",
    );
    const start = sql.indexOf("create table if not exists public.ai_send_reservations");
    const end = sql.indexOf("-- 2. One pending draft per inbound message");
    await db.query(sql.slice(start, end).replace(/\n-- -+\s*$/m, ""));
    await db.query("notify pgrst, 'reload schema'");
    await new Promise((r) => setTimeout(r, 1500));
    createdSchema = true;
  }
});
afterAll(async () => {
  if (createdSchema) {
    await db.query("drop function if exists public.fn_reserve_ai_send(uuid, uuid, text, integer)");
    await db.query("drop function if exists public.fn_release_ai_send(uuid, text)");
    await db.query("drop table if exists public.ai_send_reservations");
    await db.query("notify pgrst, 'reload schema'");
  }
  await db.end();
});

describe("withPropertyLease against the real fn_reserve_ai_send signature", () => {
  it("reserves and releases through supabase-js (the arguments hold-actions sends are accepted)", async () => {
    const admin = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const errors: unknown[] = [];
    const d = {
      admin,
      orgId: randomUUID(),
      userId: randomUUID(),
      reportError: (e: unknown) => errors.push(e),
    } as unknown as HoldActionDeps;
    const propertyId = randomUUID();

    let heldInside: unknown[] = [];
    const first = await withPropertyLease(d, propertyId, randomUUID(), async () => {
      const { rows } = await db.query(
        "select holder, extract(epoch from (expires_at - created_at))::int as secs from public.ai_send_reservations where conversation_id = $1",
        [propertyId],
      );
      heldInside = rows;
      // A second action on the same property is refused while the lease is held.
      const second = await withPropertyLease(d, propertyId, null, async () => ok(null));
      expect(second).toMatchObject({ ok: false, error: { code: "SEND_BUSY" } });
      return ok("done");
    });

    expect(errors).toEqual([]);
    expect(first).toEqual({ ok: true, data: "done" });
    expect(heldInside).toHaveLength(1);
    expect((heldInside[0] as { secs: number }).secs).toBe(SEND_LEASE_SECONDS);
    const after = await db.query("select 1 from public.ai_send_reservations where conversation_id = $1", [propertyId]);
    expect(after.rowCount).toBe(0);

    // A null inbound message id (draft with none) is accepted too.
    expect(await withPropertyLease(d, propertyId, null, async () => ok(1))).toEqual({ ok: true, data: 1 });
  });
});
