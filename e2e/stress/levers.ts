import { expireDialIntentCi } from "../support/my-leads-p2-fixture";
import type { Db } from "./db";
import { asService } from "./db";

/**
 * Per-decision time levers. There is NO universal clock: each time-dependent decision has one named
 * lever, demonstrated before the chaos sequence (`demonstrateLevers`). Everything else runs on real time.
 *
 *   intent expiry         expireIntent (fixture backdating) / backdateDispatch + the stale sweep
 *   reminder eligibility  makeReminderDue (backdate send_at / send_local_date), then call the cron route
 *   strip midnight        expireStripOverride (fixture)
 *   quiet hours           E2E_QUIET_HOURS_NOW (an env of the app under test; recorded in the report)
 *
 * PLAN DISCREPANCY (reported): the plan names `fn_fail_stale_dialpad_intents(p_cutoff_seconds := 0)`,
 * but the deployed function raises INVALID_INPUT unless the cutoff is between 30 and 900 seconds. The
 * working lever is: backdate `dispatch_authorized_at` past the cutoff, then run the stale sweep with 30.
 */

/**
 * Strip "midnight Central" lever. Own implementation: the fixture's `expireStripOverride` (e2e/support/my-leads-close-fixture.ts)
 * uses `least(pinned_until, ...)` on BOTH columns, and Postgres `least` ignores NULL, so it fills the unused column and
 * violates my_leads_strip_overrides_one_kind_check. Only the column that is set is moved into the past.
 */
export async function expireStripOverride(db: Db, propertyId: string): Promise<void> {
  await db.query(
    `update public.my_leads_strip_overrides
        set pinned_until = case when pinned_until is not null then now() - interval '1 minute' end,
            hidden_until = case when hidden_until is not null then now() - interval '1 minute' end,
            pinned_at = case when pinned_at is not null then now() - interval '2 minutes' end
      where property_id=$1`,
    [propertyId],
  );
}

/** Makes an unmatched prepared intent look expired (reuses the p2 fixture's guarded, loopback-only backdating). */
export async function expireIntent(db: Db, intentId: string): Promise<void> {
  await expireDialIntentCi(db, intentId);
}

/** Backdates dispatch authorization (intent stays inside its window) so the stale sweep marks it failed. Disposable DB only. */
export async function backdateDispatch(db: Db, intentId: string, seconds: number): Promise<void> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("alter table public.dialpad_call_intents disable trigger dialpad_call_intents_guard");
    const r = await c.query(
      "update public.dialpad_call_intents set dispatch_authorized_at = now() - make_interval(secs => $2) where id=$1 and status='prepared' and dispatch_authorized_at is not null",
      [intentId, seconds],
    );
    await c.query("alter table public.dialpad_call_intents enable trigger dialpad_call_intents_guard");
    if (r.rowCount !== 1) throw new Error("backdateDispatch: no authorized prepared intent with that id");
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Runs the stale-intent sweep directly (service role). Returns how many intents it marked failed. */
export async function runStaleSweep(db: Db, cutoffSeconds = 30): Promise<number> {
  const r = await asService(db, (c) => c.query<{ n: number }>("select public.fn_fail_stale_dialpad_intents($1, 200) as n", [cutoffSeconds]));
  return r.rows[0]!.n;
}

/** Reminder eligibility lever: pending reminders for the given tasks become due now, dated today in Chicago. */
export async function makeReminderDue(db: Db, taskIds: readonly string[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  const r = await db.query(
    "update public.seller_appointment_reminders set send_at=now()-interval '1 minute', send_local_date=(now() at time zone 'America/Chicago')::date where task_id = any($1::uuid[]) and status='pending'",
    [taskIds],
  );
  return r.rowCount ?? 0;
}

export async function scheduleReminders(db: Db, orgId: string): Promise<unknown> {
  const r = await asService(db, (c) => c.query("select public.fn_schedule_seller_reminders('30000 days'::interval,500,array[$1]::uuid[]) as v", [orgId]));
  return r.rows[0]!.v;
}

export type LeverProof = { lever: string; ok: boolean; detail: string };
