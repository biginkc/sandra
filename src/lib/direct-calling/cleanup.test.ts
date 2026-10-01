import { describe, expect, it, vi } from "vitest";

import { CLAIM_LEASE_SECS, processDueCleanups, STATUS_CHECK_EVERY_FAILED_HANGUPS, type CleanupDeps } from "./cleanup";
import { FakeStore, makeRow } from "./test-support";
import { TelnyxApiError } from "./telnyx";

const CALL = "11111111-1111-4111-8111-111111111111";
const clock = { now: new Date("2026-10-01T12:00:00.000Z") };

function setup(legs: string[] = ["leg-1"], rowOver: Record<string, unknown> = {}) {
  clock.now = new Date("2026-10-01T12:00:00.000Z");
  const store = new FakeStore();
  store.clock = () => clock.now;
  store.add(makeRow({ status: "failed", ended_at: clock.now.toISOString() }));
  for (const leg of legs) store.addCleanup({ direct_call_id: CALL, kind: "leg", leg_id: leg, ...rowOver });
  const log: string[] = [];
  const hangup = vi.fn(async (leg: string, _cmd: string) => { log.push(`hangup:${leg}`); });
  const getCall = vi.fn(async (leg: string) => { log.push(`get:${leg}`); return { isAlive: true }; });
  const claim = store.claimDueCleanups.bind(store);
  const limits: number[] = [];
  store.claimDueCleanups = async (u, n, l, limit) => { limits.push(limit); log.push("claim"); return claim(u, n, l, limit); };
  const deps: CleanupDeps = { store, hangup, getCall, listActiveCalls: async () => ({ calls: [], complete: true }), now: () => clock.now, report: vi.fn(), random: () => 0 };
  return { store, hangup, getCall, deps, log, limits };
}

describe("processDueCleanups", () => {
  it("claims one row immediately before working it, so a slow batch cannot let a later row's lease lapse", async () => {
    const { deps, log, limits } = setup(["leg-1", "leg-2", "leg-3"]);
    await processDueCleanups(deps, "user-1");
    expect(limits.every((l) => l === 1)).toBe(true);
    expect(log.filter((entry) => entry !== "claim")).toEqual(["hangup:leg-1", "hangup:leg-2", "hangup:leg-3"]);
    // Strict alternation: claim, work, claim, work, ..., then the final empty claim.
    expect(log).toEqual(["claim", "hangup:leg-1", "claim", "hangup:leg-2", "claim", "hangup:leg-3", "claim"]);
  });

  it("never hangs a leg up twice when another processor runs while a slow hangup is in flight", async () => {
    const { deps, store, hangup } = setup(["leg-1", "leg-2", "leg-3"]);
    let reentered = false;
    hangup.mockImplementation(async () => {
      if (reentered) return;
      reentered = true;
      // The first hangup takes longer than a short lease would last; a second processor (another tab or a
      // webhook) runs meanwhile and must find only the rows nobody holds.
      clock.now = new Date(clock.now.getTime() + (CLAIM_LEASE_SECS - 5) * 1000);
      await processDueCleanups(deps, "user-1");
    });
    await processDueCleanups(deps, "user-1");
    const sent = hangup.mock.calls.map((c) => c[0]);
    expect(new Set(sent).size).toBe(sent.length);
    expect([...store.cleanups.values()].every((c) => c.acked_at)).toBe(true);
  });

  it("after repeated failed hangups also asks the provider for the leg's status; is_alive:false confirms", async () => {
    const { deps, store, hangup, getCall } = setup(["leg-1"], { attempts: STATUS_CHECK_EVERY_FAILED_HANGUPS - 1 });
    hangup.mockRejectedValue(new TelnyxApiError("Telnyx returned 404", "rejected", 404));
    getCall.mockResolvedValue({ isAlive: false });
    const result = await processDueCleanups(deps, "user-1");
    expect(getCall).toHaveBeenCalledTimes(1);
    expect(result.confirmed).toBe(1);
    expect(store.legRow("leg-1")?.confirmed_at).toBeTruthy();
  });

  it("does not ask for status on early failures, and an alive or failing status check confirms nothing", async () => {
    const early = setup(["leg-1"], { attempts: 0 });
    early.hangup.mockRejectedValue(new TelnyxApiError("down", "unknown", 503));
    await processDueCleanups(early.deps, "user-1");
    expect(early.getCall).not.toHaveBeenCalled();

    const alive = setup(["leg-1"], { attempts: STATUS_CHECK_EVERY_FAILED_HANGUPS - 1 });
    alive.hangup.mockRejectedValue(new TelnyxApiError("down", "unknown", 503));
    await processDueCleanups(alive.deps, "user-1");
    expect(alive.getCall).toHaveBeenCalledTimes(1);
    expect(alive.store.legRow("leg-1")?.confirmed_at).toBeNull();

    const broken = setup(["leg-1"], { attempts: STATUS_CHECK_EVERY_FAILED_HANGUPS - 1 });
    broken.hangup.mockRejectedValue(new TelnyxApiError("down", "unknown", 503));
    broken.getCall.mockRejectedValue(new TelnyxApiError("down", "unknown", 503));
    await processDueCleanups(broken.deps, "user-1");
    expect(broken.store.legRow("leg-1")?.confirmed_at).toBeNull();
    expect(broken.store.legRow("leg-1")?.attempts).toBe(STATUS_CHECK_EVERY_FAILED_HANGUPS);
  });
});

describe("unresolved Dial reconciliation matches call id AND role", () => {
  type Listing = Awaited<ReturnType<CleanupDeps["listActiveCalls"]>>;
  function dialWorld(listings: Array<Listing | Error>) {
    const w = setup([]);
    const row = w.store.addCleanup({
    direct_call_id: CALL, kind: "unresolved_dial", dial_role: "seller",
      dial_started_at: clock.now.toISOString(),
      resolve_after: new Date(clock.now.getTime() - 1000).toISOString(), backstop_at: new Date(clock.now.getTime() + 3_600_000).toISOString(),
    });
    let i = 0;
    w.deps.listActiveCalls = async () => {
      const next = listings[Math.min(i++, listings.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    };
    const run = async () => {
      const entry = w.store.cleanups.get(row.id)!;
      entry.next_attempt_at = clock.now.toISOString();
      await processDueCleanups(w.deps, "user-1");
      return w.store.cleanups.get(row.id)!;
    };
    return { ...w, row, run };
  }
  const leg = (id: string, role: string, call = CALL) => ({ callControlId: id, clientState: { directCallId: call, role } });

  it("a browser leg of the same call never resolves a seller obligation; it gets its own leg row", async () => {
    const w = dialWorld([{ calls: [leg("BROWSER-1", "browser")], complete: true }]);
    const after = await w.run();
    expect(after.confirmed_at).toBeNull();
    expect(after.empty_matches).toBe(1); // counts as an empty listing for the SELLER role, not a resolution
    expect(w.store.legRow("BROWSER-1")).toBeDefined();
    const second = await w.run();
    expect(second.confirmed_at).not.toBeNull(); // two consecutive complete listings without a seller leg
  });

  it("an incomplete or failed listing never counts as empty", async () => {
    const w = dialWorld([
      { calls: [], complete: false },
      new Error("listing down"),
      { calls: [], complete: true },
      { calls: [], complete: false },
      { calls: [], complete: true },
      { calls: [], complete: true },
    ]);
    expect((await w.run()).empty_matches).toBe(0);
    expect((await w.run()).empty_matches).toBe(0);
    expect((await w.run()).empty_matches).toBe(1);
    const reset = await w.run(); // incomplete again: the consecutive count restarts
    expect(reset).toMatchObject({ empty_matches: 0, confirmed_at: null });
    expect((await w.run()).confirmed_at).toBeNull();
    expect((await w.run()).confirmed_at).not.toBeNull();
  });

  it("a matching-role leg becomes a leg row, is hung up, and resolves the obligation", async () => {
    const w = dialWorld([{ calls: [leg("SELLER-1", "seller"), leg("OTHER", "seller", "someone-else")], complete: true }]);
    const after = await w.run();
    expect(after.confirmed_at).not.toBeNull();
    expect(w.store.legRow("SELLER-1")).toBeDefined();
    expect(w.store.legRow("OTHER")).toBeUndefined();
    await processDueCleanups(w.deps, "user-1");
    expect(w.hangup).toHaveBeenCalledWith("SELLER-1", expect.any(String));
  });
});
