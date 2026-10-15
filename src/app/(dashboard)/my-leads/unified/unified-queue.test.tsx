vi.mock("@/components/sequences/after-attempt-drip-picker", () => ({
  AfterAttemptDripPicker: ({ propertyId, onDripChanged }: { propertyId: string; onDripChanged?: () => void }) => (
    <button type="button" data-testid="drip-picker" onClick={() => onDripChanged?.()}>Picker {propertyId}</button>
  ),
}));
vi.mock("../rep-sms-composer", () => ({
  RepSmsComposer: ({ defaultOpen }: { defaultOpen?: boolean }) => <span data-testid="composer" data-default-open={defaultOpen ? "true" : "false"} />,
}));

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queueRowFixture } from "../_components/call-next-test-support";
import type { MyLeadDetailPageResult } from "../_components/types";
import type { WorkFacts, WorkQuery } from "./contract";
import { workFacts } from "./test-support";
import { UnifiedQueue, type UnifiedQueueActions, type UnifiedQueueHandle, type UnifiedQueueProps } from "./unified-queue";
import { Q, makeServer } from "./work-queue-fixtures";

type Server = ReturnType<typeof makeServer>;

/** A full WorkFacts used as the fake server's base for a lead. */
const ROW_NO: Partial<Record<WorkFacts["reason"], string>> = {
  call_today: "2", new_lead: "3", due: "4", new_reply: "5", broken: "6", in_drip: "10", texted_last: "14", nothing_planned: "15",
};
const lead = (id: string, reason: WorkFacts["reason"], over: Partial<WorkFacts> = {}, headline: Record<string, unknown> = {}) =>
  workFacts(reason, ROW_NO[reason] ?? "5", headline, { propertyId: id, row: queueRowFixture(id, { homeownerName: `Owner ${id}`, address: `${id} Main St` }), ...over });

function seed(): Server {
  const server = makeServer(25);
  server.add("a1", lead("a1", "new_reply", { latestInbound: { at: "2026-10-14T17:00:00Z", kind: "text", messageId: "m-a1", handled: false, contactOnly: false } }, { at: "2026-10-14T17:00:00Z", kind: "text" }));
  server.add("a2", lead("a2", "new_lead", { stage: "not_contacted" }, { assignedAt: "2026-10-14T15:00:00Z", firstCallOverdue: false }));
  server.add("a3", lead("a3", "due", {}, { at: "2026-10-14T14:00:00Z", soon: false }));
  server.add("a4", lead("a4", "call_today", {}, { pinnedAt: "2026-10-14T12:00:00Z" }));
  server.add("a5", lead("a5", "broken", {
    broken: [{ kind: "drip_stuck", action: "fix_drip", at: "2026-10-14T12:00:00Z", refId: "ref-1" }],
  }, { kind: "drip_stuck", action: "fix_drip", at: "2026-10-14T12:00:00Z" }));
  server.add("w1", lead("w1", "in_drip", { place: "their_move", stage: "contacted" }, { nextRunAt: "2026-10-16T15:00:00Z" }));
  server.add("w2", lead("w2", "texted_last", { place: "their_move", stage: "offer_sent" }, { kind: "texted_silent", at: "2026-10-13T15:00:00Z", since: "2026-10-13T15:00:00Z" }));
  return server;
}

type Harness = {
  server: Server;
  loadWorkPage: ReturnType<typeof vi.fn>;
  loadWorkFacts: ReturnType<typeof vi.fn>;
  pinLead: ReturnType<typeof vi.fn>;
  dismissBroken: ReturnType<typeof vi.fn>;
  onAction: ReturnType<typeof vi.fn>;
  onQueryChange: ReturnType<typeof vi.fn>;
  onViewChange: ReturnType<typeof vi.fn>;
  onLoadDetailPage: ReturnType<typeof vi.fn>;
  handle: { current: UnifiedQueueHandle | null };
};

function messagesPage(): MyLeadDetailPageResult {
  return {
    ok: true,
    group: "messages",
    page: {
      rows: [
        { id: "t2", body: "Yes call me tomorrow", direction: "inbound", createdAt: "2026-10-14T17:00:00Z", createdLabel: "", deliveryStatus: "received", attachmentCount: 0 },
        { id: "t1", body: "Hi, are you open to an offer?", direction: "outbound", createdAt: "2026-10-14T16:00:00Z", createdLabel: "", deliveryStatus: "delivered", attachmentCount: 0 },
      ],
      hasMore: false,
      nextCursor: null,
    },
  };
}

function setup(over: Partial<UnifiedQueueProps> = {}, server: Server = seed(), query: WorkQuery = Q(), pinned: WorkFacts | null = null) {
  const h: Harness = {
    server,
    loadWorkPage: vi.fn(async ({ query: q }: { memberId: string; query: WorkQuery }) => ({ ok: true as const, page: server.page(q) })),
    loadWorkFacts: vi.fn(async ({ ids }: { memberId: string; ids: string[] }) => ({ ok: true as const, facts: server.facts(ids) })),
    pinLead: vi.fn(async () => ({ ok: true as const, pinnedAt: null })),
    dismissBroken: vi.fn(async () => ({ ok: true as const })),
    onAction: vi.fn(),
    onQueryChange: vi.fn(),
    onViewChange: vi.fn(),
    onLoadDetailPage: vi.fn(async () => messagesPage()),
    handle: { current: null },
  };
  const actions = {
    loadWorkPage: h.loadWorkPage,
    loadWorkFacts: h.loadWorkFacts,
    pinLead: h.pinLead,
    dismissBroken: h.dismissBroken,
  } as unknown as UnifiedQueueActions;
  const view = render(
    <UnifiedQueue
      initial={server.initial(query, pinned)}
      actions={actions}
      memberId="rep-1"
      canAct
      canSelectRep={false}
      repOptions={[{ id: "rep-1", label: "Maria" }]}
      selectedRepLabel="Maria"
      onRepChange={vi.fn()}
      onAction={h.onAction as unknown as UnifiedQueueProps["onAction"]}
      onViewChange={h.onViewChange as unknown as UnifiedQueueProps["onViewChange"]}
      onQueryChange={h.onQueryChange as unknown as UnifiedQueueProps["onQueryChange"]}
      onLoadDetailPage={h.onLoadDetailPage as unknown as UnifiedQueueProps["onLoadDetailPage"]}
      registerHandle={(handle) => { h.handle.current = handle; }}
      {...over}
    />,
  );
  return { h, ...view };
}

const lastQuery = (h: Harness): WorkQuery => h.loadWorkPage.mock.calls.at(-1)![0].query;
const shownIds = () => Array.from(document.querySelectorAll("[data-lead-id]")).map((el) => el.getAttribute("data-lead-id"));

describe("tabs, chips, stage", () => {
  it("shows the three tabs with their counts and the first page of Needs attention", () => {
    setup();
    expect(screen.getByTestId("work-tab-count-needs_attention")).toHaveTextContent("5");
    expect(screen.getByTestId("work-tab-count-waiting")).toHaveTextContent("2");
    expect(screen.getByTestId("work-tab-count-all")).toHaveTextContent("7");
    expect(screen.getByTestId("work-tab-needs_attention")).toHaveAttribute("aria-selected", "true");
    expect(shownIds()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("lists the Needs attention chips in the design order and requests the clicked chip", async () => {
    const { h } = setup();
    const chips = within(screen.getByRole("group", { name: "Reason" })).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("data-testid"))).toEqual([
      "work-chip-new_lead", "work-chip-call_today", "work-chip-due", "work-chip-new_reply", "work-chip-broken",
      "work-chip-offer", "work-chip-gone_quiet", "work-chip-nothing_planned", "work-chip-all",
    ]);
    await userEvent.click(screen.getByTestId("work-chip-due"));
    await waitFor(() => expect(lastQuery(h)).toEqual(Q({ chip: "due" })));
    await waitFor(() => expect(shownIds()).toEqual(["a3"]));
    expect(h.onViewChange).toHaveBeenCalled();
    expect(h.onQueryChange).toHaveBeenLastCalledWith(Q({ chip: "due" }));
  });

  it("switches tab (chip resets) and shows the Waiting chips", async () => {
    const { h } = setup();
    await userEvent.click(screen.getByTestId("work-tab-waiting"));
    await waitFor(() => expect(shownIds()).toEqual(["w1", "w2"]));
    expect(lastQuery(h)).toEqual(Q({ tab: "waiting" }));
    const chips = within(screen.getByRole("group", { name: "Reason" })).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("data-testid"))).toEqual([
      "work-chip-in_drip", "work-chip-texted_last", "work-chip-offer_out", "work-chip-callback_booked", "work-chip-all",
    ]);
  });

  it("filters by stage from the select", async () => {
    const { h } = setup();
    await userEvent.selectOptions(screen.getByTestId("work-stage-select"), "not_contacted");
    await waitFor(() => expect(lastQuery(h)).toEqual(Q({ stage: "not_contacted" })));
    await waitFor(() => expect(shownIds()).toEqual(["a2"]));
  });
});

describe("search", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sits behind the icon and is debounced about 300 ms before it queries", async () => {
    const { h } = setup();
    expect(screen.queryByTestId("work-search-input")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("work-search-open"));
    const input = screen.getByTestId("work-search-input");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "a3" } });
    expect(h.loadWorkPage).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(h.loadWorkPage).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(h.loadWorkPage).toHaveBeenCalledTimes(1);
    expect(lastQuery(h)).toEqual(Q({ search: "a3" }));
    expect(h.onQueryChange).toHaveBeenLastCalledWith(Q({ search: "a3" }));
  });
});

describe("expand and collapse all", () => {
  it("expands every row on the page, then collapses them", async () => {
    setup();
    expect(document.querySelectorAll("[data-expanded='true']")).toHaveLength(0);
    await userEvent.click(screen.getByTestId("work-toggle-all"));
    expect(document.querySelectorAll("[data-expanded='true']")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("work-toggle-all"));
    expect(document.querySelectorAll("[data-expanded='true']")).toHaveLength(0);
  });
});

describe("pagination", () => {
  it("shows page numbers over 25 rows and a click puts the page in the query/URL", async () => {
    const server = makeServer(25);
    for (let i = 1; i <= 60; i++) server.add(`p${i}`, lead(`p${i}`, "due", {}, { at: "2026-10-14T14:00:00Z", soon: false }));
    const { h } = setup({}, server);
    expect(shownIds()).toHaveLength(25);
    expect(screen.getByTestId("work-pagination")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Page 2" }));
    await waitFor(() => expect(lastQuery(h)).toEqual(Q({ page: 2 })));
    await waitFor(() => expect(shownIds()[0]).toBe("p26"));
    expect(h.onQueryChange).toHaveBeenLastCalledWith(Q({ page: 2 }));
    expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
  });
});

describe("List updated", () => {
  it("offers a Refresh when the eligible list changes under the rows, and Refresh swaps the page in", async () => {
    const { h } = setup();
    h.server.add("new1", lead("new1", "new_lead", { stage: "not_contacted" }, { assignedAt: "2026-10-14T17:30:00Z", firstCallOverdue: false }), 0);
    fireEvent(window, new Event("focus"));
    const banner = await screen.findByTestId("work-list-updated");
    expect(banner).toHaveTextContent("List updated");
    expect(shownIds()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    await userEvent.click(within(banner).getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(shownIds()).toEqual(["new1", "a1", "a2", "a3", "a4", "a5"]));
    expect(screen.queryByTestId("work-list-updated")).not.toBeInTheDocument();
  });
});

describe("row actions", () => {
  it("Call today pins the lead and re-reads it; the row that leaves the view gets a notice", async () => {
    const { h } = setup({}, seed(), Q({ chip: "new_reply" }));
    h.pinLead.mockImplementationOnce(async (input: { propertyId: string }) => {
      h.server.set(input.propertyId, { reason: "call_today", headline: { pinnedAt: "2026-10-14T18:00:00Z" } });
      return { ok: true as const, pinnedAt: "2026-10-14T18:00:00Z" };
    });
    await userEvent.click(screen.getByTestId("work-row-toggle-a1"));
    await userEvent.click(await screen.findByTestId("work-row-call-today-a1"));
    await waitFor(() => expect(h.pinLead).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: "a1", action: "pin" }));
    expect(await screen.findByTestId("work-row-removed")).toHaveTextContent("Moved out of this view");
    expect(screen.queryByTestId("work-row-a1")).not.toBeInTheDocument();
  });

  it("Undo clears the pin and the row returns to its reason in place", async () => {
    const { h } = setup();
    h.pinLead.mockImplementationOnce(async (input: { propertyId: string }) => {
      h.server.set(input.propertyId, { reason: "due", headline: { at: "2026-10-14T14:00:00Z", soon: false } });
      return { ok: true as const, pinnedAt: null };
    });
    expect(screen.getByTestId("work-row-headline-a4")).toHaveTextContent(/Call today/);
    await userEvent.click(screen.getByTestId("work-row-undo-a4"));
    await waitFor(() => expect(h.pinLead).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: "a4", action: "clear" }));
    await waitFor(() => expect(screen.queryByTestId("work-row-undo-a4")).not.toBeInTheDocument());
    expect(shownIds()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("shows the server message when Call today fails and leaves the row alone", async () => {
    const { h } = setup();
    h.pinLead.mockResolvedValueOnce({ ok: false, message: "That did not save." });
    await userEvent.click(screen.getByTestId("work-row-toggle-a2"));
    await userEvent.click(await screen.findByTestId("work-row-call-today-a2"));
    expect(await screen.findByTestId("work-action-error")).toHaveTextContent("That did not save.");
    expect(shownIds()).toContain("a2");
  });

  it("Dismiss sends the broken item's reference and re-reads the lead", async () => {
    const { h } = setup();
    h.dismissBroken.mockImplementationOnce(async (input: { propertyId: string }) => {
      h.server.set(input.propertyId, { broken: [], reason: "nothing_planned", headline: {} });
      return { ok: true as const };
    });
    await userEvent.click(screen.getByTestId("work-row-toggle-a5"));
    await userEvent.click(await screen.findByTestId("work-row-broken-dismiss-0-a5"));
    await waitFor(() => expect(h.dismissBroken).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: "a5", sourceId: "ref-1" }));
    await waitFor(() => expect(h.loadWorkFacts).toHaveBeenCalledWith({ memberId: "rep-1", ids: ["a5"] }));
  });

  it("hands stage commands to the host's existing workflows", async () => {
    const { h } = setup();
    await userEvent.click(screen.getByTestId("work-row-toggle-a3"));
    await userEvent.click(await screen.findByTestId("work-row-log-attempt-a3"));
    expect(h.onAction).toHaveBeenCalledWith("log-attempt", "a3");
  });

  it("Fix drip opens the lead page; Set drip opens the drip picker and re-reads after a change", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { h } = setup();
    await userEvent.click(screen.getByTestId("work-row-toggle-a5"));
    await userEvent.click(await screen.findByTestId("work-row-broken-fix-0-a5"));
    expect(open).toHaveBeenCalledWith("/leads/a5", "_blank", expect.any(String));
    await userEvent.click(screen.getByTestId("work-row-set-drip-a5"));
    const picker = await screen.findByTestId("drip-picker");
    expect(picker).toHaveTextContent("Picker a5");
    await userEvent.click(picker);
    await waitFor(() => expect(h.loadWorkFacts).toHaveBeenCalledWith({ memberId: "rep-1", ids: ["a5"] }));
    open.mockRestore();
  });
});

describe("conversation box and all texts", () => {
  it("tags the Us line from the message's automation (drip, campaign, Sandra)", async () => {
    for (const [automation, tag] of [["drip", "Us (drip):"], ["campaign", "Us (campaign):"], ["sandra", "Us (Sandra):"]] as const) {
      const { h } = setup();
      const page = messagesPage();
      const tagged: MyLeadDetailPageResult =
        page.ok && page.group === "messages"
          ? { ...page, page: { ...page.page, rows: page.page.rows.map((row) => (row.direction === "outbound" ? { ...row, automation } : row)) } }
          : page;
      h.onLoadDetailPage.mockResolvedValue(tagged);
      await userEvent.click(screen.getByTestId("work-row-toggle-a1"));
      expect(await screen.findByTestId("conversation-box-a1")).toHaveTextContent(tag);
      cleanup();
    }
  });

  it("loads the lead's texts when its row expands and shows the newest of each side", async () => {
    const { h } = setup();
    await userEvent.click(screen.getByTestId("work-row-toggle-a1"));
    const box = await screen.findByTestId("conversation-box-a1");
    expect(h.onLoadDetailPage).toHaveBeenCalledWith("a1", "messages", null);
    expect(box).toHaveTextContent("Us:");
    expect(box).toHaveTextContent("Hi, are you open to an offer?");
    expect(box).toHaveTextContent("Them:");
    expect(box).toHaveTextContent("Yes call me tomorrow");
    expect(h.onLoadDetailPage).toHaveBeenCalledTimes(1);
  });

  it("opens the full thread with the composer from Show all texts and Reply", async () => {
    setup();
    await userEvent.click(screen.getByTestId("work-row-toggle-a1"));
    await userEvent.click(await screen.findByTestId("conversation-show-all-a1"));
    expect(await screen.findByTestId("all-texts-a1")).toBeInTheDocument();
    expect(screen.getByTestId("composer")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("all-texts-hide-a1"));
    expect(screen.queryByTestId("all-texts-a1")).not.toBeInTheDocument();
  });

  it("the primary Reply button expands the row and opens the thread", async () => {
    setup();
    await userEvent.click(screen.getByTestId("work-row-primary-a1"));
    expect(await screen.findByTestId("all-texts-a1")).toBeInTheDocument();
    expect(document.querySelector("[data-lead-id='a1']")).toHaveAttribute("data-expanded", "true");
  });

  it("Show all texts leaves the composer closed; Reply opens it (defaultOpen)", async () => {
    setup();
    await userEvent.click(screen.getByTestId("work-row-toggle-a1"));
    await userEvent.click(await screen.findByTestId("conversation-show-all-a1"));
    expect(await screen.findByTestId("composer")).toHaveAttribute("data-default-open", "false");
    await userEvent.click(screen.getByTestId("all-texts-hide-a1"));
    await userEvent.click(screen.getByTestId("work-row-toggle-a1"));
    await userEvent.click(screen.getByTestId("work-row-toggle-a1"));
    await userEvent.click(screen.getByTestId("work-row-primary-a1"));
    expect(await screen.findByTestId("composer")).toHaveAttribute("data-default-open", "true");
  });

  it("pauses background refreshes while a thread is open", async () => {
    const { h } = setup();
    await userEvent.click(screen.getByTestId("work-row-primary-a1"));
    await screen.findByTestId("all-texts-a1");
    h.loadWorkPage.mockClear();
    fireEvent(window, new Event("focus"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(h.loadWorkPage).not.toHaveBeenCalled();
  });
});

describe("owner view texts", () => {
  it("shows the history but never the composer when viewing another rep", async () => {
    setup({ canAct: false });
    await userEvent.click(screen.getByTestId("work-row-toggle-a1"));
    await userEvent.click(await screen.findByTestId("conversation-show-all-a1"));
    expect(await screen.findByTestId("all-texts-a1")).toBeInTheDocument();
    expect(screen.queryByTestId("composer")).not.toBeInTheDocument();
  });
});

describe("owner view", () => {
  it("is read-only: every action button is disabled except Open lead", async () => {
    setup({ canAct: false });
    await userEvent.click(screen.getByTestId("work-row-toggle-a3"));
    const actions = await screen.findByTestId("work-row-actions-a3");
    const buttons = within(actions).getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) expect(button).toBeDisabled();
    expect(within(actions).getByRole("link", { name: "Open lead" })).toHaveAttribute("href", "/leads/a3");
  });
});

describe("deep link", () => {
  it("pins the linked lead at the top of its tab, expanded, and scrolls to it once", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const server = seed();
    const pinned = lead("w2", "texted_last", { place: "their_move", stage: "offer_sent" }, { kind: "texted_silent", at: "2026-10-13T15:00:00Z", since: "2026-10-13T15:00:00Z" });
    const { h } = setup({ deepLinkId: "w2", deepLinkNonce: 1 }, server, Q({ tab: "waiting" }), pinned);
    expect(shownIds()[0]).toBe("w2");
    expect(shownIds().filter((id) => id === "w2")).toHaveLength(1);
    expect(screen.getByTestId("work-row-w2")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByText("Opened from lead page")).toBeInTheDocument();
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByTestId("work-tab-all"));
    await waitFor(() => expect(h.onViewChange).toHaveBeenCalled());
    expect(scroll).toHaveBeenCalledTimes(1);
    // The pinned slot does not follow the rep into another tab.
    await waitFor(() => expect(screen.queryByText("Opened from lead page")).not.toBeInTheDocument());
  });
});

describe("empty, loading and error states", () => {
  it("says so when Needs attention is empty, and how many are waiting on them", () => {
    setup({}, makeServer(25).add("w1", lead("w1", "in_drip", { place: "their_move" })).add("w2", lead("w2", "in_drip", { place: "their_move" })));
    expect(screen.getByTestId("work-empty")).toHaveTextContent("Nothing needs you right now.");
    expect(screen.getByTestId("work-empty-hint")).toHaveTextContent("2 leads are waiting on them.");
  });

  it("leaves the waiting line out when none are waiting", () => {
    setup({}, makeServer(25));
    expect(screen.getByTestId("work-empty")).toHaveTextContent("Nothing needs you right now.");
    expect(screen.queryByTestId("work-empty-hint")).not.toBeInTheDocument();
  });

  it("has its own empty line for Waiting on them, All leads and a search", () => {
    setup({}, makeServer(25), Q({ tab: "waiting" }));
    expect(screen.getByTestId("work-empty")).toHaveTextContent("Nothing is waiting on them.");
    cleanup();
    setup({}, makeServer(25), Q({ tab: "all" }));
    expect(screen.getByTestId("work-empty")).toHaveTextContent("No leads in your queue.");
    cleanup();
    setup({}, makeServer(25), Q({ search: "elm" }));
    expect(screen.getByTestId("work-empty")).toHaveTextContent("No leads match \u201celm\u201d.");
  });

  it("keeps the last list and offers Retry now when a read fails", async () => {
    const { h } = setup();
    h.loadWorkPage.mockResolvedValueOnce({ ok: false, message: "My Leads could not load. Please retry." });
    fireEvent(window, new Event("focus"));
    const alert = await screen.findByTestId("work-error");
    expect(alert).toHaveTextContent("My Leads could not load. Please retry.");
    expect(alert).toHaveTextContent("Retrying automatically");
    expect(shownIds()).toHaveLength(5);
    await userEvent.click(within(alert).getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(screen.queryByTestId("work-error")).not.toBeInTheDocument());
  });

  it("the handle's syncQuery adopts a URL query: loads it, fills the search box, and writes nothing back", async () => {
    const { h } = setup();
    act(() => h.handle.current!.syncQuery(Q({ tab: "waiting", search: "elm" })));
    await waitFor(() => expect(h.loadWorkPage).toHaveBeenCalledWith({ memberId: "rep-1", query: Q({ tab: "waiting", search: "elm" }) }));
    expect(await screen.findByTestId("work-search-input")).toHaveValue("elm");
    expect(h.onViewChange).toHaveBeenCalled();
    expect(h.onQueryChange).not.toHaveBeenCalled();
  });

  it("registers a handle the host uses to re-read a lead and to find its queue row", async () => {
    const { h } = setup();
    expect(h.handle.current?.rowFor("a3")?.propertyId).toBe("a3");
    expect(h.handle.current?.rowFor("nope")).toBeNull();
    h.server.set("a3", { reason: "new_reply" });
    await act(async () => { await h.handle.current!.afterAction("a3"); });
    expect(h.loadWorkFacts).toHaveBeenCalledWith({ memberId: "rep-1", ids: ["a3"] });
  });
});
