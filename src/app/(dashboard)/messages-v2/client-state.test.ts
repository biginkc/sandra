import { describe, expect, it } from "vitest";

import {
  actionsEnabled,
  applyResults,
  applyThreads,
  commitIfCurrent,
  isCurrent,
  liveDiffers,
  loadedCard,
  type CardTable,
  type CheckResult,
  type LiveView,
  type Now,
  type Pinned,
  type Stamp,
  type ThreadTable,
} from "./client-state";

/**
 * Adversarial out-of-order matrix for the client state machine. For every pair of writers that can touch the same
 * card (or run), every interleaving W1-start, W2-start, {W1,W2}-finish in either order, every outcome pair, and a
 * snapshot refresh between start and finish. The final state must equal the sequential execution (start order), and
 * a card whose newest check failed must never end with actions enabled.
 */

const PINS: Pinned = {
  pinnedDraft: null,
  pinnedDraftSendable: false,
  pinnedReason: "model:unclear",
  pinnedFa: "2026-10-01T00:00:00.000000Z",
  pinnedRun: null,
  pinnedAt: "2026-10-01T00:00:00.000000Z",
  seenVersion: null,
};
const LIVE_SAME: LiveView = {
  draftId: null,
  draftSendable: false,
  flagReason: "model:unclear",
  seenFlagReason: "model:unclear",
  seenFlagAt: "2026-10-01T00:00:00.000000Z",
  seenThrough: null,
  activityAt: "2026-10-01T00:00:00.000000Z",
  runId: null,
};

const table = (key: unknown, loadOk: boolean): CardTable => ({ snapshotKey: key, cards: new Map([["c", loadedCard(key, PINS, loadOk)]]) });

/** Card writers: slice loads (ok/failed/gone) and live re-checks (ok/failed/updated/gone). */
const WRITERS: Record<string, CheckResult[]> = {
  slice: ["ok", "failed", "gone"],
  revalidate: ["ok", "failed", "updated", "gone"],
};
const pairs: Array<[string, string]> = [
  ["slice", "revalidate"],
  ["revalidate", "slice"],
  ["revalidate", "revalidate"],
  ["slice", "slice"],
];

describe("card writers: every pair, every outcome, every finish order", () => {
  for (const [w1, w2] of pairs)
    for (const r1 of WRITERS[w1])
      for (const r2 of WRITERS[w2])
        for (const loadOk of [true, false])
          it(`${w1}=${r1} then ${w2}=${r2} (load ${loadOk ? "ok" : "failed"})`, () => {
            const s1: Stamp = { snapshotKey: "K", seq: 1 };
            const s2: Stamp = { snapshotKey: "K", seq: 2 };
            const base = table("K", loadOk);
            const sequential = applyResults(applyResults(base, s1, [["c", r1]]), s2, [["c", r2]]);
            const reversed = applyResults(applyResults(base, s2, [["c", r2]]), s1, [["c", r1]]);
            expect(reversed.cards.get("c")).toEqual(sequential.cards.get("c"));
            const rec = sequential.cards.get("c")!;
            // A failed newest check never ends with actions enabled (unless a fact made the card leave anyway).
            if (r2 === "failed") expect(actionsEnabled(rec, LIVE_SAME)).toBe(false);
            if (r1 === "gone" || r2 === "gone") expect(rec.status).toBe("missing");
            if ((r1 === "updated" || r2 === "updated") && r1 !== "gone" && r2 !== "gone") expect(rec.status).toBe("updated");
            // Refreshed between start and finish: both results belong to the old snapshot and change nothing.
            const refreshed = table("K2", loadOk);
            const afterRefresh = applyResults(applyResults(refreshed, s2, [["c", r2]]), s1, [["c", r1]]);
            expect(afterRefresh).toBe(refreshed);
          });
});

describe("per-card rules", () => {
  it("never-checked card (no record) is paused", () => {
    expect(actionsEnabled(undefined, LIVE_SAME)).toBe(false);
  });
  it("a load whose version check failed starts paused; only that card's own newer ok enables it", () => {
    const t = table("K", false);
    expect(actionsEnabled(t.cards.get("c"), LIVE_SAME)).toBe(false);
    const other = applyResults(t, { snapshotKey: "K", seq: 1 }, [["someone-else", "ok"]]);
    expect(actionsEnabled(other.cards.get("c"), LIVE_SAME)).toBe(false);
    const own = applyResults(t, { snapshotKey: "K", seq: 1 }, [["c", "ok"]]);
    expect(actionsEnabled(own.cards.get("c"), LIVE_SAME)).toBe(true);
  });
  it("pinned card in a slice: a slice result older than a failed re-check keeps it paused", () => {
    const t = table("K", true);
    const failed = applyResults(t, { snapshotKey: "K", seq: 2 }, [["c", "failed"]]);
    const lateSlice = applyResults(failed, { snapshotKey: "K", seq: 1 }, [["c", "ok"]]);
    expect(actionsEnabled(lateSlice.cards.get("c"), LIVE_SAME)).toBe(false);
  });
  it("a card first seen in a slice takes its pins and that slice's outcome", () => {
    const t: CardTable = { snapshotKey: "K", cards: new Map() };
    const next = applyResults(t, { snapshotKey: "K", seq: 3 }, [["n", "ok"]], () => PINS);
    expect(next.cards.get("n")).toMatchObject({ status: "ok", lastCheckSeq: 3 });
  });
});

describe("live view vs pins: explicit null cases", () => {
  const rec = loadedCard("K", PINS, true);
  it("null flag time + reason change -> differs (Updated, disabled)", () => {
    const pinsNullFa = { ...PINS, pinnedFa: null };
    const r = loadedCard("K", pinsNullFa, true);
    const live = { ...LIVE_SAME, seenFlagAt: null, seenFlagReason: "hostile_needs_confirm" };
    expect(liveDiffers(r, live)).toBe(true);
    expect(actionsEnabled(r, live)).toBe(false);
  });
  it("same reason + new flag time -> differs", () => {
    expect(actionsEnabled(rec, { ...LIVE_SAME, seenFlagAt: "2026-10-05T00:00:00.000000Z" })).toBe(false);
  });
  it("null pinned reason vs a live reason -> differs; null vs null -> same", () => {
    const r = loadedCard("K", { ...PINS, pinnedReason: null }, true);
    expect(liveDiffers(r, { ...LIVE_SAME, flagReason: null, seenFlagReason: null })).toBe(false);
    expect(liveDiffers(r, { ...LIVE_SAME, flagReason: "x", seenFlagReason: null })).toBe(true);
  });
  it("null pinned run vs a live run -> differs", () => {
    expect(liveDiffers(rec, { ...LIVE_SAME, runId: "run-1" })).toBe(true);
  });
  it("draft moved (same through/activity) -> differs", () => {
    const r = loadedCard("K", { ...PINS, pinnedDraft: "d1", pinnedDraftSendable: true }, true);
    expect(liveDiffers(r, { ...LIVE_SAME, draftId: "d2", draftSendable: true })).toBe(true);
  });
  it("server final check found a change during build -> differs (Updated, disabled)", () => {
    expect(actionsEnabled(rec, { ...LIVE_SAME, serverChanged: true })).toBe(false);
  });
  it("identical -> actions enabled", () => {
    expect(actionsEnabled(rec, LIVE_SAME)).toBe(true);
  });
});

describe("commitIfCurrent", () => {
  it("discards a stale snapshot and re-checks inside the functional update", () => {
    let state = 0;
    let key: unknown = "A";
    const now = (): Now => ({ snapshotKey: key });
    const set = (fn: (p: number) => number) => {
      key = "B"; // the snapshot changes between scheduling and applying
      state = fn(state);
    };
    expect(commitIfCurrent({ snapshotKey: "A" }, now, set, (p) => p + 1)).toBe(true);
    expect(state).toBe(0);
    expect(commitIfCurrent({ snapshotKey: "A" }, now, set, (p) => p + 1)).toBe(false);
  });
  it("isCurrent requires the run's version when versions are stamped", () => {
    const stamp: Stamp = { snapshotKey: "K", versions: new Map([["r", "r:1"]]) };
    expect(isCurrent(stamp, { snapshotKey: "K", versionOf: () => "r:1" }, "r")).toBe(true);
    expect(isCurrent(stamp, { snapshotKey: "K", versionOf: () => "r:2" }, "r")).toBe(false);
  });
});

describe("thread writers: every pair, every outcome, every finish order", () => {
  const T = (key: unknown): ThreadTable => ({ snapshotKey: key, text: new Map(), failed: new Set() });
  const fetchResult = (ok: boolean, body: string) =>
    [ok ? [["r", { lastOutbound: null, reply: body }] as const] : [], ok ? ["r"] : [], ok ? [] : ["r"]] as const;

  for (const ok1 of [true, false])
    for (const ok2 of [true, false]) {
      it(`same version: F1 ${ok1 ? "ok" : "fail"}, F2 ${ok2 ? "ok" : "fail"} (live fetch vs day load)`, () => {
        const now: Now = { snapshotKey: 1, versionOf: () => "r:1" };
        const f1: Stamp = { snapshotKey: 1, seq: 1, versions: new Map([["r", "r:1"]]) };
        const f2: Stamp = { snapshotKey: 1, seq: 2, versions: new Map([["r", "r:1"]]) };
        const [l1, ok1Ids, fail1] = fetchResult(ok1, "one");
        const [l2, ok2Ids, fail2] = fetchResult(ok2, "two");
        const seq = applyThreads(applyThreads(T(1), f1, now, l1, ok1Ids, fail1), f2, now, l2, ok2Ids, fail2);
        const rev = applyThreads(applyThreads(T(1), f2, now, l2, ok2Ids, fail2), f1, now, l1, ok1Ids, fail1);
        expect(rev.failed).toEqual(seq.failed);
        expect(rev.failed.has("r")).toBe(!ok2);
      });

      it(`version bumped between: older F1 ${ok1 ? "ok" : "fail"} never overrides newer F2 ${ok2 ? "ok" : "fail"}`, () => {
        const now: Now = { snapshotKey: 1, versionOf: () => "r:2" };
        const f1: Stamp = { snapshotKey: 1, seq: 1, versions: new Map([["r", "r:1"]]) };
        const f2: Stamp = { snapshotKey: 1, seq: 2, versions: new Map([["r", "r:2"]]) };
        const [l1, ok1Ids, fail1] = fetchResult(ok1, "old");
        const [l2, ok2Ids, fail2] = fetchResult(ok2, "new");
        const onlyNewer = applyThreads(T(1), f2, now, l2, ok2Ids, fail2);
        for (const order of [0, 1]) {
          const out =
            order === 0
              ? applyThreads(applyThreads(T(1), f1, now, l1, ok1Ids, fail1), f2, now, l2, ok2Ids, fail2)
              : applyThreads(applyThreads(T(1), f2, now, l2, ok2Ids, fail2), f1, now, l1, ok1Ids, fail1);
          expect(out.failed).toEqual(onlyNewer.failed);
          expect(out.text.get("r")?.reply).toBe(onlyNewer.text.get("r")?.reply);
        }
      });

      it(`snapshot refreshed between start and finish: F1 ${ok1 ? "ok" : "fail"} / F2 ${ok2 ? "ok" : "fail"} change nothing`, () => {
        const now: Now = { snapshotKey: 2, versionOf: () => "r:1" };
        const stale1: Stamp = { snapshotKey: 1, seq: 1, versions: new Map([["r", "r:1"]]) };
        const stale2: Stamp = { snapshotKey: 1, seq: 2, versions: new Map([["r", "r:1"]]) };
        const fresh = T(2);
        const [l1, a1, f1] = fetchResult(ok1, "x");
        const [l2, a2, f2] = fetchResult(ok2, "y");
        expect(applyThreads(applyThreads(fresh, stale1, now, l1, a1, f1), stale2, now, l2, a2, f2)).toBe(fresh);
      });
    }

  it("retry success for an older version after the newer version failed: failure stays", () => {
    const now: Now = { snapshotKey: 1, versionOf: () => "r:2" };
    const newerFail = applyThreads(T(1), { snapshotKey: 1, seq: 2, versions: new Map([["r", "r:2"]]) }, now, [], [], ["r"]);
    const olderOk = applyThreads(newerFail, { snapshotKey: 1, seq: 3, versions: new Map([["r", "r:1"]]) }, now, [["r", { lastOutbound: null, reply: "old" }]], ["r"], []);
    expect(olderOk.failed.has("r")).toBe(true);
    expect(olderOk.text.get("r")).toBeUndefined();
  });
});
