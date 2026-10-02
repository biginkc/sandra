import { describe, expect, it } from "vitest";

import { runRandomRun } from "./driver";
import { Harness } from "./harness";
import { checkInvariants } from "./invariants";
import { rng } from "./trace";

/**
 * The gate must have teeth: each mutant below re-creates one Norma function
 * with a deliberate bug, then a short randomised run must be reported as
 * violating the invariant that exists to catch it. If a mutant is NOT caught,
 * the gate is blind to that class of bug and this test fails.
 */
type Mutant = { name: string; invariant: string; apply: (q: (sql: string) => Promise<{ rows: Record<string, string>[] }>) => Promise<void> };

async function mutateFunction(q: (sql: string) => Promise<{ rows: Record<string, string>[] }>, signature: string, from: string, to: string) {
  const def = (await q(`select pg_get_functiondef('${signature}'::regprocedure) as d`)).rows[0]!.d as string;
  if (!def.includes(from)) throw new Error(`mutant anchor not found in ${signature}: ${from}`);
  await q(def.replace(from, to));
}

const MUTANTS: Mutant[] = [
  {
    name: "the stale-call sweep ignores an open Norma hold",
    invariant: "5",
    apply: (q) =>
      mutateFunction(q, "public.sweep_resume_call_in_progress(uuid[], timestamptz)", "if public.fn_norma_hold_active(e.property_id) then", "if false then"),
  },
  {
    name: "the one-open-request index is gone (a second request can open)",
    invariant: "1",
    apply: async (q) => {
      await q("drop index public.norma_call_requests_one_open_per_property_idx");
    },
  },
  {
    name: "a not_interested completion also creates a task",
    invariant: "3",
    apply: (q) =>
      mutateFunction(q, "public.fn_norma_complete_call(uuid, text, text, jsonb)", "if p_outcome in ('callback_requested', 'reached_no_callback', 'wrong_number') then", "if p_outcome in ('callback_requested', 'reached_no_callback', 'wrong_number', 'not_interested') then"),
  },
  {
    name: "a completion forgets its Slack outbox row",
    invariant: "8",
    apply: (q) =>
      mutateFunction(
        q,
        "public.fn_norma_complete_call(uuid, text, text, jsonb)",
        "insert into public.norma_notifications (request_id, kind)\n  values (r.id, 'call_completed')\n  on conflict (request_id, kind) do nothing;",
        "null;",
      ),
  },
  {
    name: "eligibility never blocks (DNC / not_interested leads get dialled)",
    invariant: "2",
    apply: async (q) => {
      await q("alter function public.fn_norma_eligibility(uuid, uuid, text) rename to fn_norma_eligibility_orig");
      await q(`create function public.fn_norma_eligibility(p_property_id uuid, p_contact_id uuid, p_phone_e164 text)
               returns table (eligible boolean, block_reason text) language sql security definer set search_path = public as $$ select true, null::text $$`);
      await q("grant execute on function public.fn_norma_eligibility(uuid, uuid, text) to service_role");
    },
  },
];

describe("the stress gate has teeth", () => {
  it.each(MUTANTS)("catches: $name", async ({ invariant, apply }) => {
    const h = await Harness.create(rng(77));
    try {
      await apply((sql) => h.scratch.pool.query(sql) as never);
      await runRandomRun(h, 77, 70);
      const { violations } = await checkInvariants(h, { settled: true });
      expect(violations.filter((v) => v.startsWith(`[${invariant}]`)).length, `no [${invariant}] violation among: ${violations.slice(0, 5).join(" | ")}`).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });
});
