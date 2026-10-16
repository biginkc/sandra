import { describe, expect, it, vi } from "vitest";

import { STATE_TO_TZ } from "@/lib/messaging/quiet-hours";

import type { PreSendResult } from "./pre-send-transition";
import { QUEUE_TICK_BUDGET_MS, runNormaQueueTick, type QueueTickDeps, type QueueTickStore } from "./queue-tick";

// PROPOSED (RED) shape for the cron core (plan "Cron" 1-4, rules 2/4/7/8, S1, C19). Injectable like reconcile.ts.
// The `store` port is a set of THIN WRAPPERS over the SQL contract (docs/norma/queue-sql-contract.md s.4), one per contract function:
//   releaseExpiredLeases(nowIso) -> fn_norma_queue_release_expired_leases(p_now)       (tick step 2)
//   sweepReplies()               -> fn_norma_queue_sweep_replies()                      (tick step 3)
//   sweepBlocks()                -> fn_norma_queue_sweep_blocks()                       (tick step 3)
//   pauseUnknownState(entryId)   -> fn_norma_queue_pause_unknown_state(p_entry_id)
//   claim(entryId, nowIso, limits) -> fn_norma_queue_claim(p_entry_id, p_now, p_queue_enabled, p_max_concurrent, p_daily_cap, p_cap_tz)
//   applyPresend(requestId, token) -> fn_norma_queue_apply_presend(p_request_id, p_result)
// plus two read ports that are not contract functions (listLiveEntries, listDueEntryIds) and createRequest (-> fn_norma_create_request_v2).
// Transitions (parking, blocking, rescheduling, zone, requeue/pause/done after a dispatch result) are owned by SQL: the tick never writes
// an entry transition and never reschedules. Rescheduling is SQL's for BOTH capacity_precheck and window_closed (claim recomputes
// next_attempt_at); the tick only reacts to the claim result (continue / stop). Tests assert what the tick asks for, never SQL.
// Claim results mirror fn_norma_queue_claim: claimed | blocked:<reason> | window_closed | disabled | not_due | not_claimable | capacity_precheck | already_open | unknown_state.

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const T0 = Date.parse("2030-01-08T16:00:00Z");
const CLAIMED = (id: string) => ({
  result: "claimed" as const, entryId: id, propertyId: `p-${id}`, contactId: `c-${id}`, phoneE164: "+18165550142",
  requestedBy: "u1", repContext: "ctx", leaseToken: `lease-${id}`, dispatchToken: `disp-${id}`,
});
const LIMITS = { enabled: true, maxConcurrent: 5, dailyCap: 200, capTz: "America/Chicago" };

type LiveEntry = Awaited<ReturnType<QueueTickStore["listLiveEntries"]>>[number];
type Overrides = Partial<QueueTickStore> & {
  due?: string[];
  live?: LiveEntry[];
};

function setup(overrides: Overrides = {}, depsOverride: Partial<QueueTickDeps> = {}) {
  const order: string[] = [];
  const pending = [...(overrides.due ?? [])];
  const wrap = <T,>(name: string, fn: (...args: never[]) => T) => vi.fn((...args: never[]) => { order.push(name); return fn(...args); });
  const store = {
    releaseExpiredLeases: wrap("releaseExpiredLeases", async () => 0),
    sweepReplies: wrap("sweepReplies", async () => 0),
    sweepBlocks: wrap("sweepBlocks", async () => 0),
    listLiveEntries: wrap("listLiveEntries", async () => overrides.live ?? []),
    pauseUnknownState: wrap("pauseUnknownState", async () => "paused"),
    listDueEntryIds: wrap("listDueEntryIds", async () => pending.slice(0, 25)),
    claim: wrap("claim", async (id: string) => {
      const index = pending.indexOf(id);
      if (index >= 0) pending.splice(index, 1);
      return CLAIMED(id);
    }),
    createRequest: wrap("createRequest", async () => ({ outcome: "created" as const, requestId: "req-1" })),
    applyPresend: wrap("applyPresend", async () => "applied"),
  } as unknown as QueueTickStore;
  Object.assign(store, Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "due" && key !== "live")));
  const dispatch = vi.fn(async () => ({ kind: "dispatched" as const }));
  let clock = T0;
  const deps: QueueTickDeps = {
    config: { enabled: true, maxConcurrent: 5, dailyCap: 200, capTz: "America/Chicago", problems: [] },
    now: () => clock,
    store,
    dispatch: dispatch as QueueTickDeps["dispatch"],
    ...depsOverride,
  };
  return { deps, store: store as unknown as Record<string, ReturnType<typeof vi.fn>>, dispatch, order, advance: (ms: number) => { clock += ms; } };
}

const entry = (over: Partial<LiveEntry> & Record<string, unknown> = {}) =>
  ({ id: "q1", propertyId: "p1", status: "queued", propertyState: "MO", ...over }) as LiveEntry;

describe("runNormaQueueTick — flag", () => {
  it("flag off -> { skipped: 'disabled' } and not a single store read or write", async () => {
    const t = setup({ due: ["e1"] }, { config: { enabled: false, maxConcurrent: 5, dailyCap: 200, capTz: "America/Chicago", problems: [] } });
    expect(await runNormaQueueTick(t.deps)).toEqual({ skipped: "disabled" });
    for (const fn of Object.values(t.store)) expect(fn).not.toHaveBeenCalled();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("an invalid config (fail closed) is also skipped as disabled", async () => {
    const t = setup({ due: ["e1"] }, { config: { enabled: false, maxConcurrent: null, dailyCap: null, capTz: "America/Chicago", problems: ["bad"] } });
    expect(await runNormaQueueTick(t.deps)).toEqual({ skipped: "disabled" });
    expect(t.dispatch).not.toHaveBeenCalled();
  });
});

describe("runNormaQueueTick — maintenance order and sweeps (SQL owns every transition)", () => {
  it("runs lease watchdog -> reply sweep -> block sweep -> unknown-state pause -> claim loop", async () => {
    const t = setup({ due: ["e1"], live: [entry({ propertyState: "ZZ" })] });
    await runNormaQueueTick(t.deps);
    const first = (name: string) => t.order.indexOf(name);
    expect(first("releaseExpiredLeases")).toBe(0);
    expect(first("releaseExpiredLeases")).toBeLessThan(first("sweepReplies"));
    expect(first("sweepReplies")).toBeLessThan(first("sweepBlocks"));
    expect(first("sweepBlocks")).toBeLessThan(first("pauseUnknownState"));
    expect(first("pauseUnknownState")).toBeLessThan(first("claim"));
  });

  it("lease watchdog is asked once, with the tick clock", async () => {
    const t = setup({});
    await runNormaQueueTick(t.deps);
    expect(t.store.releaseExpiredLeases).toHaveBeenCalledTimes(1);
    expect(t.store.releaseExpiredLeases).toHaveBeenCalledWith(new Date(T0).toISOString());
  });

  it("each sweep is one argument-less call per tick: the watermark, blocks and parking rules live in SQL (no per-entry reads or writes)", async () => {
    const t = setup({ due: ["e1", "e2"] });
    await runNormaQueueTick(t.deps);
    expect(t.store.sweepReplies).toHaveBeenCalledTimes(1);
    expect(t.store.sweepReplies).toHaveBeenCalledWith();
    expect(t.store.sweepBlocks).toHaveBeenCalledTimes(1);
    expect(t.store.sweepBlocks).toHaveBeenCalledWith();
  });

  it.each(["releaseExpiredLeases", "sweepReplies", "sweepBlocks"] as const)("a failing %s does not stop the rest of the tick", async (name) => {
    const t = setup({ due: ["e1"], [name]: vi.fn(async () => { throw new Error("db"); }) as never });
    const summary = await runNormaQueueTick(t.deps);
    expect(summary).toMatchObject({ errors: expect.any(Number) });
    expect((summary as { errors: number }).errors).toBeGreaterThanOrEqual(1);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  describe("unknown state (pause_unknown_state asked per live entry whose CURRENT state has no zone)", () => {
    it.each([["ZZ"], [null], [""]])("a queued entry whose property state is %j is paused through pauseUnknownState, not guessed", async (propertyState) => {
      const t = setup({ live: [entry({ propertyState })] });
      await runNormaQueueTick(t.deps);
      expect(t.store.pauseUnknownState).toHaveBeenCalledWith("q1");
    });

    it("a calling entry with an unknown state is also asked (SQL rotates the token; the in-flight call still settles)", async () => {
      const t = setup({ live: [entry({ id: "c1", status: "calling", propertyState: "ZZ" })] });
      await runNormaQueueTick(t.deps);
      expect(t.store.pauseUnknownState).toHaveBeenCalledWith("c1");
    });

    it("known states (every key of STATE_TO_TZ) are never asked", async () => {
      const live = Object.keys(STATE_TO_TZ).map((state, i) => entry({ id: `k${i}`, propertyId: `p${i}`, propertyState: state }));
      const t = setup({ live });
      await runNormaQueueTick(t.deps);
      expect(t.store.pauseUnknownState).not.toHaveBeenCalled();
    });

    it("an already-paused entry is not asked again", async () => {
      const t = setup({ live: [entry({ status: "paused", propertyState: "ZZ" })] });
      await runNormaQueueTick(t.deps);
      expect(t.store.pauseUnknownState).not.toHaveBeenCalled();
    });

    it("a throwing pauseUnknownState is an error for that entry only; the others and the claim loop carry on", async () => {
      const t = setup({
        due: ["e1"],
        live: [entry({ id: "u1", propertyState: "ZZ" }), entry({ id: "u2", propertyId: "p2", propertyState: "ZZ" })],
        pauseUnknownState: vi.fn(async (id: string) => { if (id === "u1") throw new Error("db"); return "paused"; }) as never,
      });
      const summary = await runNormaQueueTick(t.deps);
      expect(t.store.pauseUnknownState).toHaveBeenCalledTimes(2);
      expect(summary).toMatchObject({ errors: 1 });
      expect(t.dispatch).toHaveBeenCalledTimes(1);
    });
  });
});

describe("runNormaQueueTick — claim -> create -> dispatch loop", () => {
  it("happy path: claim (with the config limits), create (with lease), dispatch with the dispatch token, nothing applied", async () => {
    const t = setup({ due: ["e1"] });
    const summary = await runNormaQueueTick(t.deps);
    expect(t.store.claim).toHaveBeenCalledWith("e1", new Date(T0).toISOString(), LIMITS);
    expect(t.store.createRequest).toHaveBeenCalledWith(expect.objectContaining({ entryId: "e1", leaseToken: "lease-e1", propertyId: "p-e1", contactId: "c-e1", requestedBy: "u1", repContext: "ctx" }));
    expect(t.dispatch).toHaveBeenCalledWith("req-1", expect.objectContaining({ entryId: "e1", dispatchToken: "disp-e1" }));
    expect(t.store.applyPresend).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ claimed: 1, dispatched: 1, stoppedBy: "no_due" });
  });

  it("no per-tick ceiling: 150 due entries are all processed (no sleeps, clock fixed)", async () => {
    const t = setup({ due: Array.from({ length: 150 }, (_, i) => `e${i}`) });
    const summary = await runNormaQueueTick(t.deps);
    expect(t.dispatch).toHaveBeenCalledTimes(150);
    expect(summary).toMatchObject({ claimed: 150, dispatched: 150, stoppedBy: "no_due" });
  });

  it("stops when nothing is due", async () => {
    const t = setup({ due: [] });
    expect(await runNormaQueueTick(t.deps)).toMatchObject({ claimed: 0, stoppedBy: "no_due" });
    expect(t.store.claim).not.toHaveBeenCalled();
  });

  it("never claims the same entry twice in one tick, even if it is still due after a refusal", async () => {
    const t = setup({
      listDueEntryIds: vi.fn(async () => ["e1"]) as never,
      claim: vi.fn(async () => ({ result: "window_closed" as const })) as never,
    });
    await runNormaQueueTick(t.deps);
    expect(t.store.claim).toHaveBeenCalledTimes(1);
  });

  describe("budget (~50 s)", () => {
    it("exports the budget the cron route sizes maxDuration against", () => {
      expect(QUEUE_TICK_BUDGET_MS).toBe(50_000);
    });

    it("stops starting new work once the budget is spent", async () => {
      const t = setup({ due: ["e1", "e2", "e3", "e4", "e5"] });
      t.dispatch.mockImplementation(async () => { t.advance(30_000); return { kind: "dispatched" as const }; });
      const summary = await runNormaQueueTick(t.deps);
      // starts at 0s and 30s; the third start would be at 60s (> 50s)
      expect(t.dispatch).toHaveBeenCalledTimes(2);
      expect(summary).toMatchObject({ stoppedBy: "budget" });
    });
  });

  describe("claim results (SQL already moved the entry; the tick only reacts)", () => {
    it("blocked:<reason> -> entry was already ended in SQL; no request, no dispatch, nothing applied, loop continues", async () => {
      const t = setup({
        due: ["e1", "e2"],
        claim: vi.fn(async (id: string) => (id === "e1" ? { result: "blocked:dnc" } : CLAIMED(id))) as never,
      });
      await runNormaQueueTick(t.deps);
      expect(t.store.createRequest).toHaveBeenCalledTimes(1);
      expect(t.dispatch).toHaveBeenCalledTimes(1);
      expect(t.store.applyPresend).not.toHaveBeenCalled();
    });

    it("window_closed -> SQL recomputed next_attempt_at inside claim: the tick creates nothing, writes nothing, continues", async () => {
      const t = setup({
        due: ["e1", "e2"],
        claim: vi.fn(async (id: string) => (id === "e1" ? { result: "window_closed" } : CLAIMED(id))) as never,
      });
      await runNormaQueueTick(t.deps);
      expect(t.store.createRequest).toHaveBeenCalledTimes(1);
      expect(t.store.applyPresend).not.toHaveBeenCalled();
      expect(t.dispatch).toHaveBeenCalledTimes(1);
    });

    it.each(["not_due", "not_claimable", "already_open", "unknown_state"])("%s -> skipped silently (SQL owns the entry), loop continues", async (result) => {
      const t = setup({
        due: ["e1", "e2"],
        claim: vi.fn(async (id: string) => (id === "e1" ? { result } : CLAIMED(id))) as never,
      });
      await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).not.toHaveBeenCalled();
      expect(t.store.createRequest).toHaveBeenCalledTimes(1);
      expect(t.dispatch).toHaveBeenCalledTimes(1);
    });

    it("capacity_precheck -> SQL recomputed next_attempt_at inside claim: no request, nothing written by the tick, and the loop stops for this tick", async () => {
      const t = setup({
        due: ["e1", "e2", "e3"],
        claim: vi.fn(async () => ({ result: "capacity_precheck" })) as never,
      });
      const summary = await runNormaQueueTick(t.deps);
      expect(t.store.claim).toHaveBeenCalledTimes(1);
      expect(t.store.createRequest).not.toHaveBeenCalled();
      expect(t.store.applyPresend).not.toHaveBeenCalled();
      expect(t.dispatch).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ claimed: 0, stoppedBy: "capacity" });
    });

    it("disabled (the SQL flag says off) -> stop the loop, dispatch nothing", async () => {
      const t = setup({ due: ["e1", "e2"], claim: vi.fn(async () => ({ result: "disabled" })) as never });
      const summary = await runNormaQueueTick(t.deps);
      expect(t.store.claim).toHaveBeenCalledTimes(1);
      expect(t.dispatch).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ stoppedBy: "disabled" });
    });
  });

  describe("create results", () => {
    it("already_open -> nothing created, no dispatch, nothing applied (the other open request settles the entry; the lease watchdog covers the rest)", async () => {
      const t = setup({ due: ["e1", "e2"], createRequest: vi.fn(async () => ({ outcome: "already_open" as const, requestId: "r0" })) as never });
      await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).not.toHaveBeenCalled();
      expect(t.dispatch).not.toHaveBeenCalled();
    });

    it("blocked with a request id -> applyPresend(requestId, 'ineligible:<reason>'); no dispatch", async () => {
      const t = setup({ due: ["e1"], createRequest: vi.fn(async () => ({ outcome: "blocked" as const, requestId: "req-blocked", blockReason: "dnc_locked" })) as never });
      await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).toHaveBeenCalledWith("req-blocked", "ineligible:dnc_locked");
      expect(t.dispatch).not.toHaveBeenCalled();
    });

    it("blocked with NO request id (nothing was created, button parity) -> applyPresend is never called with a null id; no dispatch, not an error", async () => {
      const t = setup({ due: ["e1"], createRequest: vi.fn(async () => ({ outcome: "blocked" as const, requestId: null, blockReason: "dnc_locked" })) as never });
      const summary = await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).not.toHaveBeenCalled();
      expect(t.dispatch).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ errors: 0 });
    });

    it("a throwing create is counted as an error and the loop moves on (the lease watchdog recovers the entry)", async () => {
      const t = setup({
        due: ["e1", "e2"],
        createRequest: vi.fn(async (input: { entryId: string }) => {
          if (input.entryId === "e1") throw new Error("create failed");
          return { outcome: "created" as const, requestId: "req-2" };
        }) as never,
      });
      const summary = await runNormaQueueTick(t.deps);
      expect(summary).toMatchObject({ errors: 1, dispatched: 1 });
    });
  });

  describe("dispatch results -> the exact contract token handed to applyPresend(requestId, token) (rule 4; SQL does the transition)", () => {
    it.each<[PreSendResult, string]>([
      [{ kind: "queue_refused", reason: "window_closed" }, "queue_refused:window_closed"],
      [{ kind: "queue_refused", reason: "lease_expired" }, "queue_refused:lease_expired"],
      [{ kind: "gate", reason: "dispatch_disabled" }, "gate:dispatch_disabled"],
      [{ kind: "gate", reason: "number_not_allowed" }, "gate:number_not_allowed"],
      [{ kind: "bland_not_configured" }, "bland_not_configured"],
      [{ kind: "pre_send_error" }, "pre_send_error"],
      [{ kind: "ineligible", reason: "dnc_locked" }, "ineligible:dnc_locked"],
      [{ kind: "ineligible", reason: "voice_consent_opted_out" }, "ineligible:voice_consent_opted_out"],
      [{ kind: "number_busy" }, "number_busy"],
    ])("%j -> applyPresend('req-1', %j); loop continues", async (result, token) => {
      const t = setup({ due: ["e1", "e2"] });
      t.dispatch.mockResolvedValueOnce(result as never);
      await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).toHaveBeenCalledTimes(1);
      expect(t.store.applyPresend).toHaveBeenCalledWith("req-1", token);
      expect(t.dispatch).toHaveBeenCalledTimes(2);
    });

    it.each([400, 401, 403, 404, 422, 429])("Bland HTTP %i (4xx, not 408) -> bland_rejected:%i", async (httpStatus) => {
      const t = setup({ due: ["e1", "e2"] });
      t.dispatch.mockResolvedValueOnce({ kind: "bland_http", httpStatus } as never);
      await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).toHaveBeenCalledWith("req-1", `bland_rejected:${httpStatus}`);
      expect(t.dispatch).toHaveBeenCalledTimes(2);
    });

    it.each([408, 500, 502, 503, 504])("Bland HTTP %i (408 / 5xx) -> bland_unknown (never bland_rejected)", async (httpStatus) => {
      const t = setup({ due: ["e1", "e2"] });
      t.dispatch.mockResolvedValueOnce({ kind: "bland_http", httpStatus } as never);
      await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).toHaveBeenCalledWith("req-1", "bland_unknown");
      expect(t.dispatch).toHaveBeenCalledTimes(2);
    });

    it("Bland timeout -> bland_unknown", async () => {
      const t = setup({ due: ["e1", "e2"] });
      t.dispatch.mockResolvedValueOnce({ kind: "bland_timeout" } as never);
      await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).toHaveBeenCalledWith("req-1", "bland_unknown");
      expect(t.dispatch).toHaveBeenCalledTimes(2);
    });

    it.each(["capacity_concurrency", "capacity_daily"] as const)("%s -> applyPresend token, then STOP the loop (capacity refusal)", async (kind) => {
      const t = setup({ due: ["e1", "e2", "e3"] });
      t.dispatch.mockResolvedValueOnce({ kind } as never);
      const summary = await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).toHaveBeenCalledWith("req-1", kind);
      expect(t.dispatch).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ stoppedBy: "capacity" });
    });

    it("number_busy is per-number, not account capacity: apply the token and keep going", async () => {
      const t = setup({ due: ["e1", "e2"] });
      t.dispatch.mockResolvedValueOnce({ kind: "number_busy" } as never);
      const summary = await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).toHaveBeenCalledWith("req-1", "number_busy");
      expect(t.dispatch).toHaveBeenCalledTimes(2);
      expect(summary).not.toMatchObject({ stoppedBy: "capacity" });
    });

    it("dispatched (an accepted send) -> nothing applied: bind and settlement are the webhook's job", async () => {
      const t = setup({ due: ["e1"] });
      await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).not.toHaveBeenCalled();
    });

    it("not_claimed (another worker owns it) -> nothing written, loop continues", async () => {
      const t = setup({ due: ["e1", "e2"] });
      t.dispatch.mockResolvedValueOnce({ kind: "not_claimed" } as never);
      await runNormaQueueTick(t.deps);
      expect(t.store.applyPresend).not.toHaveBeenCalled();
      expect(t.dispatch).toHaveBeenCalledTimes(2);
    });

    it("a throwing dispatch is an error, not a crash; the request stays open for reconcile", async () => {
      const t = setup({ due: ["e1", "e2"] });
      t.dispatch.mockRejectedValueOnce(new Error("boom"));
      const summary = await runNormaQueueTick(t.deps);
      expect(summary).toMatchObject({ errors: 1 });
      expect(t.dispatch).toHaveBeenCalledTimes(2);
      expect(t.store.applyPresend).not.toHaveBeenCalled();
    });

    it("a throwing applyPresend is an error for that entry only (reconcile closes the stranded row); the loop continues", async () => {
      const t = setup({ due: ["e1", "e2"], applyPresend: vi.fn(async () => { throw new Error("db"); }) as never });
      t.dispatch.mockResolvedValueOnce({ kind: "pre_send_error" } as never);
      const summary = await runNormaQueueTick(t.deps);
      expect(summary).toMatchObject({ errors: 1 });
      expect(t.dispatch).toHaveBeenCalledTimes(2);
    });
  });

  it("capacity_daily stops the loop for THIS tick only: the next tick tries the same entry again", async () => {
    const due = ["e1", "e2"];
    const t = setup({ listDueEntryIds: vi.fn(async () => [...due]) as never });
    t.dispatch.mockResolvedValueOnce({ kind: "capacity_daily" } as never);
    const first = await runNormaQueueTick(t.deps);
    expect(first).toMatchObject({ stoppedBy: "capacity" });
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    const second = await runNormaQueueTick(t.deps);
    expect(t.store.claim).toHaveBeenCalledWith("e1", expect.any(String), LIMITS);
    expect(t.dispatch.mock.calls.length).toBeGreaterThan(1);
    expect(second).not.toMatchObject({ skipped: expect.anything() });
  });

  it.each([
    ["MAX_CONCURRENT unset", { enabled: false, maxConcurrent: null, dailyCap: 200, capTz: "America/Chicago", problems: ["NORMA_QUEUE_MAX_CONCURRENT"] }],
    ["DAILY_CAP unset", { enabled: false, maxConcurrent: 5, dailyCap: null, capTz: "America/Chicago", problems: ["NORMA_QUEUE_DAILY_CAP"] }],
  ])("%s fails closed: the tick is skipped and nothing is read, claimed or dispatched", async (_label, config) => {
    const t = setup({ due: ["e1"] }, { config });
    expect(await runNormaQueueTick(t.deps)).toEqual({ skipped: "disabled" });
    for (const fn of Object.values(t.store)) expect(fn).not.toHaveBeenCalled();
    expect(t.dispatch).not.toHaveBeenCalled();
  });
});
