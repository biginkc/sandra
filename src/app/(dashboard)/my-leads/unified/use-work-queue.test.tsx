import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LoadWorkFactsResult,
  LoadWorkPageResult,
  WorkFacts,
  WorkQuery,
} from "./contract";
import { useWorkQueue } from "./use-work-queue";
import { Q, makeServer, mkFacts } from "./work-queue-fixtures";

const T0 = new Date("2026-10-15T12:00:00Z");
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  hidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
});
afterEach(() => vi.useRealTimers());

type Server = ReturnType<typeof makeServer>;

function setup(
  server: Server,
  query: WorkQuery = Q(),
  extra: {
    pinned?: WorkFacts | null;
    refreshIntervalMs?: number;
    paused?: boolean;
  } = {},
) {
  const loadPage = vi.fn(
    async (_m: string, q: WorkQuery): Promise<LoadWorkPageResult> => ({
      ok: true,
      page: server.page(q),
    }),
  );
  const loadFacts = vi.fn(
    async (_m: string, ids: string[]): Promise<LoadWorkFactsResult> => ({
      ok: true,
      facts: server.facts(ids),
    }),
  );
  const onQueryChange = vi.fn();
  const initial = server.initial(query, extra.pinned ?? null);
  const hook = renderHook(
    (p: { paused: boolean; memberId: string }) =>
      useWorkQueue({
        initial,
        memberId: p.memberId,
        loadPage,
        loadFacts,
        paused: p.paused,
        onQueryChange,
        refreshIntervalMs: extra.refreshIntervalMs,
      }),
    { initialProps: { paused: extra.paused ?? false, memberId: "m1" } },
  );
  return { ...hook, loadPage, loadFacts, onQueryChange };
}

const advance = (ms: number) =>
  act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const flush = () => advance(0);
const ids = (r: { current: { rows: { facts: WorkFacts }[] } }) =>
  r.current.rows.map((x) => x.facts.propertyId);
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("query changes", () => {
  it("renders the initial page and counts", () => {
    const server = makeServer().addMany("L", 3);
    const { result } = setup(server);
    expect(ids(result)).toEqual(["L1", "L2", "L3"]);
    expect(result.current.tabCounts.needs_attention).toBe(3);
    expect(result.current.total).toBe(3);
    expect(result.current.loading).toBe(false);
  });

  it("tab/chip/stage/search reset page to 1, setPage keeps the rest, and each change calls onQueryChange", async () => {
    const server = makeServer(2).addMany("L", 6);
    const { result, onQueryChange, loadPage } = setup(server, Q({ page: 2 }));
    await act(async () => result.current.setPage(3));
    await flush();
    expect(onQueryChange).toHaveBeenLastCalledWith(Q({ page: 3 }));
    await act(async () => result.current.setChip("new_reply"));
    await flush();
    expect(onQueryChange).toHaveBeenLastCalledWith(
      Q({ chip: "new_reply", page: 1 }),
    );
    await act(async () => result.current.setPage(2));
    await act(async () => result.current.setStage("contacted"));
    await flush();
    expect(onQueryChange).toHaveBeenLastCalledWith(
      Q({ chip: "new_reply", stage: "contacted", page: 1 }),
    );
    await act(async () => result.current.setPage(2));
    await act(async () => result.current.setSearch("main"));
    await flush();
    expect(onQueryChange).toHaveBeenLastCalledWith(
      Q({ chip: "new_reply", stage: "contacted", search: "main", page: 1 }),
    );
    await act(async () => result.current.setPage(2));
    await act(async () => result.current.setTab("waiting"));
    await flush();
    expect(onQueryChange).toHaveBeenLastCalledWith(
      Q({
        tab: "waiting",
        chip: "all",
        stage: "contacted",
        search: "main",
        page: 1,
      }),
    );
    expect(loadPage).toHaveBeenLastCalledWith("m1", result.current.query);
  });

  it("does nothing when the query is unchanged", async () => {
    const server = makeServer().addMany("L", 2);
    const { result, onQueryChange, loadPage } = setup(server);
    await act(async () => result.current.setTab("needs_attention"));
    await act(async () => result.current.setPage(1));
    expect(onQueryChange).not.toHaveBeenCalled();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("syncQuery adopts a whole query (Back/Forward), loads it, and never calls onQueryChange", async () => {
    const server = makeServer()
      .addMany("L", 2)
      .add("W", { place: "their_move", reason: "in_drip" });
    const { result, onQueryChange, loadPage } = setup(server);
    await act(async () =>
      result.current.syncQuery(Q({ tab: "waiting", search: "elm" })),
    );
    await flush();
    expect(loadPage).toHaveBeenCalledWith(
      "m1",
      Q({ tab: "waiting", search: "elm" }),
    );
    expect(result.current.query).toEqual(Q({ tab: "waiting", search: "elm" }));
    expect(onQueryChange).not.toHaveBeenCalled();
    // Same query again is a no-op.
    loadPage.mockClear();
    await act(async () =>
      result.current.syncQuery(Q({ tab: "waiting", search: "elm" })),
    );
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("a page clamp after syncQuery rewrites the URL instead of adding history", async () => {
    const server = makeServer(2).addMany("L", 4);
    const { result, onQueryChange } = setup(server);
    await act(async () => result.current.syncQuery(Q({ page: 9 })));
    await flush();
    expect(result.current.query.page).toBe(2);
    expect(onQueryChange).toHaveBeenCalledExactlyOnceWith(Q({ page: 2 }), {
      replace: true,
    });
  });

  it("drops responses for stale sequences (out-of-order resolution)", async () => {
    const server = makeServer()
      .addMany("L", 2)
      .add("W", { place: "their_move", reason: "in_drip" });
    const { result, loadPage } = setup(server);
    const slow = deferred<LoadWorkPageResult>();
    loadPage.mockImplementationOnce(() => slow.promise); // setTab('waiting')
    await act(async () => result.current.setTab("waiting"));
    await act(async () => result.current.setTab("all")); // fast, default impl
    await flush();
    expect(result.current.query.tab).toBe("all");
    expect(ids(result)).toEqual(["L1", "L2", "W"]);
    await act(async () =>
      slow.resolve({ ok: true, page: server.page(Q({ tab: "waiting" })) }),
    );
    await flush();
    expect(ids(result)).toEqual(["L1", "L2", "W"]);
    expect(result.current.loading).toBe(false);
  });

  it("drops a background read that was issued before a query change", async () => {
    const server = makeServer()
      .addMany("L", 2)
      .add("W", { place: "their_move", reason: "in_drip" });
    const { result, loadPage } = setup(server);
    const slow = deferred<LoadWorkPageResult>();
    loadPage.mockImplementationOnce(() => slow.promise);
    await advance(30_000); // tick in flight
    await act(async () => result.current.setTab("waiting"));
    await flush();
    await act(async () => slow.resolve({ ok: true, page: server.page(Q()) }));
    await flush();
    expect(ids(result)).toEqual(["W"]);
    expect(result.current.query.tab).toBe("waiting");
  });

  it("adopts the server's page when it clamps the request, and tells the container", async () => {
    const server = makeServer(2).addMany("L", 4);
    const { result, onQueryChange } = setup(server);
    await act(async () => result.current.setPage(9));
    await flush();
    expect(result.current.query.page).toBe(2);
    expect(ids(result)).toEqual(["L3", "L4"]);
    expect(onQueryChange).toHaveBeenNthCalledWith(1, Q({ page: 9 }));
    expect(onQueryChange).toHaveBeenNthCalledWith(2, Q({ page: 2 }), {
      replace: true,
    });
  });
});

describe("scope change", () => {
  it("resets everything for a new member and reloads, keeping the committed search", async () => {
    const server = makeServer().addMany("L", 3);
    const { result, rerender, loadPage, onQueryChange } = setup(
      server,
      Q({ tab: "waiting", search: "elm", page: 2 }),
    );
    server.remove("L1");
    rerender({ paused: false, memberId: "m2" });
    await flush();
    expect(loadPage).toHaveBeenCalledWith("m2", Q({ search: "elm" }));
    expect(onQueryChange).toHaveBeenCalledWith(Q({ search: "elm" }), {
      replace: true,
    });
    expect(ids(result)).toEqual(["L2", "L3"]);
  });
});

describe("refresh timers", () => {
  it("refreshes every 30 s; unchanged revision replaces facts in place", async () => {
    const server = makeServer().addMany("L", 3);
    const { result, loadPage, loadFacts } = setup(server);
    server.set("L2", { attemptsCount: 4 });
    await advance(30_000);
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadFacts).not.toHaveBeenCalled();
    expect(result.current.rows[1].facts.attemptsCount).toBe(4);
    expect(result.current.listUpdated).toBeNull();
  });

  it("skips while the tab is hidden and refreshes when it returns (visibility and focus)", async () => {
    const server = makeServer().addMany("L", 2);
    const { loadPage } = setup(server);
    hidden = true;
    await advance(60_000);
    expect(loadPage).not.toHaveBeenCalled();
    hidden = false;
    await act(
      async () => void document.dispatchEvent(new Event("visibilitychange")),
    );
    await flush();
    expect(loadPage).toHaveBeenCalledTimes(1);
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("does not refresh while paused, then refreshes once when the composer closes (reply arriving on page 2)", async () => {
    const server = makeServer(2).addMany("L", 6);
    const { result, rerender, loadPage } = setup(server, Q({ page: 2 }), {
      paused: true,
    });
    server.add("NEW", {}, 0);
    await advance(90_000);
    expect(loadPage).not.toHaveBeenCalled();
    expect(ids(result)).toEqual(["L3", "L4"]);
    rerender({ paused: false, memberId: "m1" });
    await flush();
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(result.current.listUpdated).not.toBeNull();
    expect(ids(result)).toEqual(["L3", "L4"]); // retained, never reshuffled under the composer
  });

  it("catches a clock-only transition at nextChangeAt with no writes and re-arms after the read", async () => {
    const server = makeServer().add("A").add("B");
    server.flip("B", T0.getTime() + 90_000, {
      place: "their_move",
      reason: "texted_last",
    });
    server.add("C");
    server.flip("C", T0.getTime() + 150_000, {
      place: "their_move",
      reason: "gone_quiet",
    });
    const { result, loadPage } = setup(server, Q(), {
      refreshIntervalMs: 3_600_000,
    });
    await advance(89_000);
    expect(loadPage).not.toHaveBeenCalled();
    await advance(2_000); // 91 s
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(result.current.listUpdated).not.toBeNull();
    expect(
      result.current.rows.find((r) => r.facts.propertyId === "B")?.leftView,
    ).toBe(true);
    expect(ids(result)).toEqual(["A", "B", "C"]); // retained until the user refreshes
    await advance(60_000); // re-armed for C at 150 s
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(
      result.current.rows.find((r) => r.facts.propertyId === "C")?.leftView,
    ).toBe(true);
  });

  it("never schedules the boundary read sooner than 1 s", async () => {
    const server = makeServer().add("A");
    server.flip("A", T0.getTime() + 100, { place: "their_move" });
    const { loadPage } = setup(server, Q(), { refreshIntervalMs: 3_600_000 });
    await advance(900);
    expect(loadPage).not.toHaveBeenCalled();
    await advance(200);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });
});

describe("revision changes keep the list", () => {
  it("insertion above page 2: keeps displayed ids, refreshes their facts, counts update, Refresh swaps in", async () => {
    const server = makeServer(3).addMany("L", 8);
    const { result, loadFacts, onQueryChange } = setup(server, Q({ page: 2 }));
    expect(ids(result)).toEqual(["L4", "L5", "L6"]);
    server.add("NEW", {}, 0);
    server.set("L5", { attemptsCount: 9 });
    await advance(30_000);
    expect(ids(result)).toEqual(["L4", "L5", "L6"]);
    expect(loadFacts).toHaveBeenCalledWith("m1", ["L4", "L5", "L6"]);
    expect(result.current.rows[1].facts.attemptsCount).toBe(9);
    expect(result.current.listUpdated).toEqual({
      total: 9,
      counts: { needs_attention: 9, waiting: 0, all: 9 },
    });
    expect(result.current.tabCounts.needs_attention).toBe(9);
    act(() => result.current.refresh());
    await flush();
    expect(ids(result)).toEqual(["L3", "L4", "L5"]);
    expect(result.current.listUpdated).toBeNull();
    expect(onQueryChange).not.toHaveBeenCalled();
  });

  it("deletion above page 2 is handled the same way", async () => {
    const server = makeServer(3).addMany("L", 8);
    const { result } = setup(server, Q({ page: 2 }));
    server.remove("L1");
    await advance(30_000);
    expect(ids(result)).toEqual(["L4", "L5", "L6"]);
    expect(result.current.listUpdated?.total).toBe(7);
    act(() => result.current.refresh());
    await flush();
    expect(ids(result)).toEqual(["L5", "L6", "L7"]);
  });

  it("a retained row that left the tab stays (leftView) through timer reads and goes on Refresh", async () => {
    const server = makeServer().addMany("L", 3);
    const { result } = setup(server);
    server.set("L2", { place: "their_move", reason: "texted_last" });
    await advance(30_000);
    await advance(30_000);
    expect(ids(result)).toEqual(["L1", "L2", "L3"]);
    expect(result.current.rows.map((r) => r.leftView)).toEqual([
      false,
      true,
      false,
    ]);
    expect(result.current.tabCounts).toMatchObject({
      needs_attention: 2,
      waiting: 1,
    });
    act(() => result.current.refresh());
    await flush();
    expect(ids(result)).toEqual(["L1", "L3"]);
  });

  it("removes rows the facts read reports missing, with a notice", async () => {
    const server = makeServer().addMany("L", 3);
    const { result } = setup(server);
    server.remove("L2");
    await advance(30_000);
    expect(ids(result)).toEqual(["L1", "L3"]);
    expect(result.current.notice).toBe("No longer in your queue");
    act(() => result.current.dismissNotice());
    expect(result.current.notice).toBeNull();
  });

  it("last page shrinking to empty: retained until Refresh, then clamps to the last page", async () => {
    const server = makeServer(2).addMany("L", 5);
    const { result, onQueryChange } = setup(server, Q({ page: 3 }));
    expect(ids(result)).toEqual(["L5"]);
    server.remove("L5");
    await advance(30_000);
    expect(ids(result)).toEqual([]);
    expect(result.current.query.page).toBe(3);
    act(() => result.current.refresh());
    await flush();
    expect(result.current.query.page).toBe(2);
    expect(ids(result)).toEqual(["L3", "L4"]);
    expect(onQueryChange).toHaveBeenLastCalledWith(Q({ page: 2 }), {
      replace: true,
    });
  });

  it("counts always come from one response: all three sets match the newest read while rows are retained", async () => {
    const server = makeServer(2).addMany("L", 4);
    const { result } = setup(server);
    server.add(
      "W",
      { place: "their_move", reason: "in_drip", stage: "offer_sent" },
      0,
    );
    server.add("N", { reason: "due", stage: "needs_offer" }, 0);
    await advance(30_000);
    const newest = server.page(Q());
    expect(result.current.tabCounts).toEqual(newest.tabCounts);
    expect(result.current.chipCounts).toEqual(newest.chipCounts);
    expect(result.current.stageCounts).toEqual(newest.stageCounts);
    expect(ids(result)).toEqual(["L1", "L2"]);
  });
});

describe("errors", () => {
  it("keeps the last good list on a failed read, shows the error, and clears it on the next good tick", async () => {
    const server = makeServer().addMany("L", 2);
    const { result, loadPage } = setup(server);
    loadPage.mockResolvedValueOnce({ ok: false, message: "boom" });
    await advance(30_000);
    expect(result.current.error).toBe("boom");
    expect(ids(result)).toEqual(["L1", "L2"]);
    await advance(30_000);
    expect(result.current.error).toBeNull();
  });

  it("a thrown read is an error too, and retryNow retries immediately", async () => {
    const server = makeServer().addMany("L", 2);
    const { result, loadPage } = setup(server);
    loadPage.mockRejectedValueOnce(new Error("network"));
    await advance(30_000);
    expect(result.current.error).toBe("My Leads could not refresh.");
    act(() => result.current.retryNow());
    await flush();
    expect(result.current.error).toBeNull();
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("first read failed on the server (page null): the next tick loads the list", async () => {
    const server = makeServer().addMany("L", 2);
    const initial = {
      ...server.initial(Q()),
      page: null,
      error: "Couldn't load your leads.",
    };
    const loadPage = vi.fn(
      async (_m: string, q: WorkQuery): Promise<LoadWorkPageResult> => ({
        ok: true,
        page: server.page(q),
      }),
    );
    const { result } = renderHook(() =>
      useWorkQueue({
        initial,
        memberId: "m1",
        loadPage,
        loadFacts: vi.fn(),
        paused: false,
      }),
    );
    expect(result.current.error).toBe("Couldn't load your leads.");
    expect(result.current.rows).toEqual([]);
    await advance(30_000);
    expect(result.current.error).toBeNull();
    expect(ids(result)).toEqual(["L1", "L2"]);
  });

  it("a failed query load keeps the last list and the next tick swaps in the requested page", async () => {
    const server = makeServer()
      .addMany("L", 2)
      .add("W", { place: "their_move", reason: "in_drip" });
    const { result, loadPage } = setup(server);
    loadPage.mockResolvedValueOnce({ ok: false, message: "boom" });
    await act(async () => result.current.setTab("waiting"));
    await flush();
    expect(result.current.error).toBe("boom");
    expect(ids(result)).toEqual(["L1", "L2"]);
    expect(result.current.stale).toBe(true); // the rows belong to the earlier view
    await advance(30_000);
    expect(ids(result)).toEqual(["W"]);
    expect(result.current.error).toBeNull();
    expect(result.current.stale).toBe(false);
  });

  it("a failed navigation read marks the rows stale until a retry succeeds", async () => {
    const server = makeServer()
      .addMany("L", 2)
      .add("W", { place: "their_move", reason: "in_drip" });
    const { result, loadPage } = setup(server);
    expect(result.current.stale).toBe(false);
    loadPage.mockResolvedValueOnce({ ok: false, message: "boom" });
    await act(async () => result.current.setTab("waiting"));
    await flush();
    expect(result.current.stale).toBe(true);
    await act(async () => result.current.retryNow());
    await flush();
    expect(result.current.stale).toBe(false);
    expect(ids(result)).toEqual(["W"]);
  });
});

describe("afterAction", () => {
  it("no-answer call with New reply still open keeps the row and updates it in place", async () => {
    const server = makeServer().addMany("L", 3);
    const { result, loadFacts, loadPage } = setup(server);
    server.set("L2", { attemptsCount: 1, lastTouchAt: "2026-10-15T12:00:00Z" });
    await act(async () => void (await result.current.afterAction("L2")));
    expect(loadFacts).toHaveBeenCalledWith("m1", ["L2"]);
    expect(loadPage).toHaveBeenCalledTimes(1); // counts read
    expect(ids(result)).toEqual(["L1", "L2", "L3"]);
    expect(result.current.rows[1].facts.attemptsCount).toBe(1);
    expect(result.current.notice).toBeNull();
    expect(result.current.listUpdated).toBeNull();
  });

  it("a reply removes the row with a one-line notice and refreshes the counts", async () => {
    const server = makeServer().addMany("L", 3);
    const { result } = setup(server);
    server.set("L2", { place: "their_move", reason: "texted_last" });
    await act(async () => void (await result.current.afterAction("L2")));
    expect(ids(result)).toEqual(["L1", "L3"]);
    expect(result.current.notice).toBe("Moved to Waiting on them");
    expect(result.current.tabCounts).toMatchObject({
      needs_attention: 2,
      waiting: 1,
    });
    expect(result.current.listUpdated).toBeNull(); // last page: the read matches what is on screen
  });

  it("a lead that leaves the chip but stays in the tab is removed too", async () => {
    const server = makeServer().addMany("L", 2);
    const { result } = setup(server, Q({ chip: "new_reply" }));
    server.set("L1", { reason: "due" });
    await act(async () => void (await result.current.afterAction("L1")));
    expect(ids(result)).toEqual(["L2"]);
    expect(result.current.notice).toBe("Moved out of this view");
  });

  it("the stage filter counts: a lead whose stage changed leaves the stage view", async () => {
    const server = makeServer().addMany("L", 2);
    const { result } = setup(server, Q({ stage: "contacted" }));
    server.set("L1", { stage: "needs_offer" });
    await act(async () => void (await result.current.afterAction("L1")));
    expect(ids(result)).toEqual(["L2"]);
  });

  it("counts read does not reorder: a replacement row from the next page is offered via List updated", async () => {
    const server = makeServer(2).addMany("L", 4);
    const { result } = setup(server);
    server.set("L1", { place: "their_move", reason: "texted_last" });
    await act(async () => void (await result.current.afterAction("L1")));
    expect(ids(result)).toEqual(["L2"]);
    expect(result.current.listUpdated).not.toBeNull();
    expect(result.current.tabCounts.needs_attention).toBe(3);
  });

  it("a failed facts read leaves the row and sets an error", async () => {
    const server = makeServer().addMany("L", 2);
    const { result, loadFacts, loadPage } = setup(server);
    loadFacts.mockResolvedValueOnce({ ok: false, message: "nope" });
    server.set("L1", { place: "their_move", reason: "texted_last" });
    await act(async () => void (await result.current.afterAction("L1")));
    expect(ids(result)).toEqual(["L1", "L2"]);
    expect(result.current.error).toBe("My Leads could not refresh.");
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("an older facts response cannot overwrite a newer one for the same lead", async () => {
    const server = makeServer().addMany("L", 2);
    const { result, loadFacts } = setup(server);
    const slow = deferred<LoadWorkFactsResult>();
    const oldFacts = server.facts(["L1"]); // taken before the write
    loadFacts.mockImplementationOnce(() => slow.promise);
    const first = result.current.afterAction("L1");
    await flush();
    server.set("L1", { reason: "due", headline: { marker: "new" } });
    await act(async () => void (await result.current.afterAction("L1"))); // newer read, default impl
    expect(
      result.current.rows.find((r) => r.facts.propertyId === "L1")!.facts
        .reason,
    ).toBe("due");
    await act(async () => {
      slow.resolve({ ok: true, facts: oldFacts });
      await first;
    });
    expect(
      result.current.rows.find((r) => r.facts.propertyId === "L1")!.facts
        .reason,
    ).toBe("due");
  });

  it("a lead the server no longer knows is removed with a notice", async () => {
    const server = makeServer().addMany("L", 2);
    const { result } = setup(server);
    server.remove("L1");
    await act(async () => void (await result.current.afterAction("L1")));
    expect(ids(result)).toEqual(["L2"]);
    expect(result.current.notice).toBe("No longer in your queue");
  });

  it("a timer read that started before the action is dropped", async () => {
    const server = makeServer().addMany("L", 3);
    const { result, loadPage } = setup(server);
    const slow = deferred<LoadWorkPageResult>();
    loadPage.mockImplementationOnce(() => slow.promise);
    const stale = server.page(Q()); // taken before the write
    await advance(30_000);
    server.set("L2", { place: "their_move", reason: "texted_last" });
    await act(async () => void (await result.current.afterAction("L2")));
    await act(async () => slow.resolve({ ok: true, page: stale }));
    await flush();
    expect(ids(result)).toEqual(["L1", "L3"]);
    expect(result.current.tabCounts.waiting).toBe(1);
  });
});

describe("shared read clock", () => {
  it("(a) action facts requested before a page refresh but resolving after it do not remove the row the page showed", async () => {
    const server = makeServer().addMany("L", 3);
    const { result, loadFacts } = setup(server);
    const slow = deferred<LoadWorkFactsResult>();
    server.set("L2", { place: "their_move", reason: "texted_last" });
    const movedFacts = server.facts(["L2"]);
    server.set("L2", { place: "your_move", reason: "new_reply" });
    loadFacts.mockImplementationOnce(() => slow.promise);
    let first!: Promise<void>;
    act(() => void (first = result.current.afterAction("L2")));
    await flush();
    await advance(30_000); // page refresh: L2 is back in the view
    await act(async () => {
      slow.resolve({ ok: true, facts: movedFacts });
      await first;
    });
    expect(ids(result)).toEqual(["L1", "L2", "L3"]);
    expect(result.current.rows[1].facts.place).toBe("your_move");
    expect(result.current.notice).toBeNull();
  });

  it("(b) a navigation read started before an action but resolving after it keeps the action's facts", async () => {
    const server = makeServer().addMany("L", 3);
    const { result, loadPage } = setup(server);
    const slow = deferred<LoadWorkPageResult>();
    const oldPage = server.page(Q({ page: 1, search: "" }));
    loadPage.mockImplementationOnce(() => slow.promise);
    act(() => result.current.setStage(null)); // unchanged: no nav
    act(() => result.current.setSearch("x")); // nav starts (deferred)
    await flush();
    server.set("L2", { attemptsCount: 4 });
    await act(async () => void (await result.current.afterAction("L2")));
    expect(
      result.current.rows.find((r) => r.facts.propertyId === "L2")!.facts
        .attemptsCount,
    ).toBe(4);
    await act(async () => slow.resolve({ ok: true, page: oldPage }));
    await flush();
    expect(
      result.current.rows.find((r) => r.facts.propertyId === "L2")!.facts
        .attemptsCount,
    ).toBe(4);
  });

  it("(c) an older navigation response keeps the newer counts and the removed row stays gone, with a fresh read", async () => {
    const server = makeServer().addMany("L", 3);
    const { result, loadPage } = setup(server);
    const slow = deferred<LoadWorkPageResult>();
    const oldPage = server.page(Q({ page: 1, search: "x" }));
    loadPage.mockImplementationOnce(() => slow.promise);
    act(() => result.current.setSearch("x")); // nav starts (deferred, stamped first)
    await flush();
    server.set("L2", { place: "their_move", reason: "texted_last" });
    await act(async () => void (await result.current.afterAction("L2")));
    const newer = result.current.tabCounts;
    expect(newer.needs_attention).toBe(2);
    await act(async () => slow.resolve({ ok: true, page: oldPage }));
    await flush();
    expect(result.current.tabCounts).toEqual(newer);
    expect(result.current.tabCounts.needs_attention).not.toBe(oldPage.tabCounts.needs_attention);
    expect(ids(result)).not.toContain("L2");
    expect(loadPage.mock.calls.length).toBe(3); // nav, after-action counts, fresh read
  });

  it("refreshes an off-page pinned lead on every accepted refresh, not only when the revision changes", async () => {
    const server = makeServer(2).addMany("L", 4).add("P"); // P is on page 3, off the displayed page
    const { result, loadFacts } = setup(server, Q(), { pinned: mkFacts("P") });
    server.set("P", { attemptsCount: 7 }); // revision unchanged
    await advance(30_000);
    expect(loadFacts).toHaveBeenCalledWith("m1", ["P"]);
    expect(result.current.rows.find((r) => r.pinned)!.facts.attemptsCount).toBe(
      7,
    );
  });
});

describe("pinned deep-linked lead", () => {
  it("shows at the top of its own tab regardless of page, once", () => {
    const server = makeServer(2).addMany("L", 6);
    const pinned = mkFacts("P");
    server.add("P");
    const { result } = setup(server, Q({ page: 3 }), { pinned });
    expect(
      result.current.rows.map((r) => [r.facts.propertyId, r.pinned]),
    ).toEqual([
      ["P", true],
      ["L5", false],
      ["L6", false],
    ]);
  });

  it("is not shown on a different tab, and is dropped once the user changes the view", async () => {
    const server = makeServer()
      .addMany("L", 2)
      .add("W", { place: "their_move", reason: "in_drip" });
    const { result } = setup(server, Q(), { pinned: mkFacts("P") });
    expect(result.current.rows[0].pinned).toBe(true);
    await act(async () => result.current.setPage(1));
    expect(result.current.rows[0].pinned).toBe(true); // unchanged query
    await act(async () => result.current.setTab("waiting"));
    await flush();
    expect(result.current.rows.some((r) => r.pinned)).toBe(false);
    await act(async () => result.current.setTab("needs_attention"));
    await flush();
    expect(result.current.rows.some((r) => r.pinned)).toBe(false);
  });

  it("is dropped by chip, stage, search and page changes", async () => {
    for (const change of [
      (h: ReturnType<typeof setup>["result"]) => h.current.setChip("due"),
      (h: ReturnType<typeof setup>["result"]) =>
        h.current.setStage("contacted"),
      (h: ReturnType<typeof setup>["result"]) => h.current.setSearch("x"),
      (h: ReturnType<typeof setup>["result"]) => h.current.setPage(2),
    ]) {
      const server = makeServer().addMany("L", 2);
      const { result } = setup(server, Q(), { pinned: mkFacts("P") });
      await act(async () => change(result));
      await flush();
      expect(result.current.rows.some((r) => r.pinned)).toBe(false);
    }
  });

  it("is dropped when its facts say it left the tab", async () => {
    const server = makeServer().addMany("L", 2).add("P");
    const { result } = setup(server, Q(), { pinned: mkFacts("P") });
    server.add("EXTRA"); // make the revision change so facts are fetched
    server.set("P", { place: "their_move", reason: "texted_last" });
    await advance(30_000);
    expect(result.current.rows.some((r) => r.pinned)).toBe(false);
    expect(result.current.notice).toBe("Moved to Waiting on them");
  });
});
