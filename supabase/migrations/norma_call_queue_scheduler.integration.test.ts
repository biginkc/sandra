// RED tests: the Norma queue cadence oracle against SQL `fn_norma_queue_next_slot_for`.
// NOTE: when the migration number is reserved this file is renamed to
// `<version>_norma_call_queue_scheduler.integration.test.ts`.
// Contract: docs/norma/queue-sql-contract.md section 4 (scheduler). The fixture table is shared with the TypeScript
// scheduler (src/lib/norma/queue/scheduler.fixtures.ts), so SQL and TS are held to the same hand-computed oracle.
// Local-only: one rollback-only transaction on a loopback database, SAVEPOINT per test.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SCHEDULER_FIXTURES } from "../../src/lib/norma/queue/scheduler.fixtures";
import { openQueueFixture, type QueueFixture } from "@tests/integration/norma-queue-fixture";

const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres";

const holder: { fx?: QueueFixture } = {};
beforeAll(async () => { holder.fx = await openQueueFixture(dbUrl); }, 120_000);
afterAll(async () => { await holder.fx?.close(); });
const run = (fn: (db: Client) => Promise<void>) => holder.fx!.isolated(fn);

// The pure function takes no clock and reads no table: (state, send instants, now) -> jsonb.
// PROPOSED result shape: {"kind":"slot","phase":"A|B|C","slot":"A_am|A_pm|B|C","at":"<ISO-8601 instant with explicit offset>"}
// | {"kind":"exhausted"} | {"kind":"unknown_state"}  (exactly these keys, nothing else).
type SlotJson = { kind: string; phase?: string; slot?: string; at?: string };
async function nextSlotFor(db: Client, state: string, sends: string[], now: string): Promise<SlotJson> {
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  try {
    return (await db.query("select public.fn_norma_queue_next_slot_for($1::text,$2::timestamptz[],$3::timestamptz) as r", [state, sends, now])).rows[0]!.r as SlotJson;
  } finally {
    await db.query("reset role").catch(() => {});
    await db.query("select set_config('request.jwt.claim.role','',true)").catch(() => {});
  }
}

describe("norma queue scheduler oracle (fn_norma_queue_next_slot_for)", () => {
  it("the shared fixture table is non-empty and every name is unique", () => {
    expect(SCHEDULER_FIXTURES.length).toBeGreaterThan(0);
    expect(new Set(SCHEDULER_FIXTURES.map((f) => f.name)).size).toBe(SCHEDULER_FIXTURES.length);
  });

  it.each(SCHEDULER_FIXTURES.map((f) => [f.name, f] as const))("%s", (_name, fx) =>
    run(async (db) => {
      const result = await nextSlotFor(db, fx.state, fx.sends, fx.now);
      if (fx.expected.kind === "slot") {
        expect(Object.keys(result).sort()).toEqual(["at", "kind", "phase", "slot"]);
        expect(result.kind).toBe("slot");
        expect(result.phase).toBe(fx.expected.phase);
        expect(result.slot).toBe(fx.expected.slot);
        // exact instant equality (timezone-offset spelling is irrelevant)
        expect(new Date(result.at as string).getTime()).toBe(new Date(fx.expected.at).getTime());
      } else {
        expect(result).toEqual({ kind: fx.expected.kind });
      }
    }));

  it("is pure: the same inputs give the same answer regardless of the SQL clock seam", () =>
    run(async (db) => {
      const fx = SCHEDULER_FIXTURES.find((f) => f.expected.kind === "slot")!;
      const setWall = (iso: string) => db.query(`create or replace function norma_private.fn_norma_wallclock() returns timestamptz language sql volatile as $w$ select '${iso}'::timestamptz $w$`);
      await setWall("2030-01-07T14:00:00Z");
      const a = await nextSlotFor(db, fx.state, fx.sends, fx.now);
      await setWall("2041-06-30T03:00:00Z");
      const b = await nextSlotFor(db, fx.state, fx.sends, fx.now);
      expect(b).toEqual(a);
    }));
});
