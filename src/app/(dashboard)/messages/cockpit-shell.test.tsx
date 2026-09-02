import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CockpitView } from "./cockpit-view";
import type { InboxFilterCounts } from "./inbox-filters";

const replaceCalls: string[] = [];
const pushCalls: string[] = [];
let searchParamsValue = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn((url: string) => {
      pushCalls.push(url);
    }),
    replace: vi.fn((url: string) => {
      replaceCalls.push(url);
    }),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(searchParamsValue),
  usePathname: () => "/messages",
}));

vi.mock("./actions", () => ({
  listQueuedPage: vi.fn(async () => ({
    ok: true,
    data: { rows: [], hasMore: false },
  })),
  releaseMessage: vi.fn(),
  pauseQueuedMessage: vi.fn(),
  resumeQueuedMessage: vi.fn(),
  cancelQueuedMessage: vi.fn(),
  deleteQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  matchUnknownSender: vi.fn(),
  createContactFromUnknown: vi.fn(),
  dismissUnknownSender: vi.fn(),
  restoreDismissedSender: vi.fn(),
  mergeUnknownSenderToProperty: vi.fn(),
  getQueueStats: vi.fn(async () => ({
    ok: true,
    data: {
      queued: 0,
      paused: 0,
      sentOutToday: 0,
      failedToday: 0,
      nextScheduledFor: null,
      lastScheduledFor: null,
    },
  })),
}));

vi.mock("../leads/actions", () => ({
  listFromNumbers: vi.fn(async () => ({ ok: true, data: [] })),
  sendSmsFromLead: vi.fn(),
  loadLeadVars: vi.fn(async () => ({ ok: true, data: {} })),
  listOrgUsers: vi.fn(async () => ({ ok: true, data: [] })),
  listPropertyOrgUsers: vi.fn(async () => ({ ok: true, data: [] })),
  updateLeadAssignee: vi.fn(),
}));

vi.mock("../templates/actions", () => ({
  listTemplates: vi.fn(async () => ({ ok: true, data: [] })),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
    realtime: { setAuth: vi.fn() },
    channel: () => {
      const ch = {
        on: () => ch,
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const baseProps = {
  filter: "all" as const,
  threads: [],
  queued: [],
  threadDetail: null,
  unknownSenders: [],
  filterCounts: {
    all: 0,
    mine: 0,
    unassigned: 0,
    unknown: 0,
    dismissed: 0,
    unread: 0,
    escalated: 0,
    dispo: 0,
    needs_outcome: 0,
  } satisfies InboxFilterCounts,
  assigneeEmails: {},
  currentUserId: "user-1",
  queueStats: {
    queued: 0,
    paused: 0,
    sentOutToday: 0,
    failedToday: 0,
    nextScheduledFor: null,
    lastScheduledFor: null,
  },
  hideDnc: true,
  hiddenDncCount: 0,
  nowMs: Date.parse("2026-08-17T12:00:00.000Z"),
};

describe("<CockpitView /> shell — tabs + cadence", () => {
  it("defaults to the Inbox tab when activeTab='inbox' (test 7)", () => {
    render(<CockpitView {...baseProps} activeTab="inbox" />);

    expect(screen.getByTestId("tab-inbox")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("tab-outbox")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it.each([
    ["unknown", 12],
    ["dismissed", 3],
  ] as const)(
    "uses the active %s sender count in the Inbox tab badge",
    (filter, expectedCount) => {
      render(
        <CockpitView
          {...baseProps}
          activeTab="inbox"
          filter={filter}
          inboxTotal={53_261}
          filterCounts={{
            ...baseProps.filterCounts,
            unknown: 12,
            dismissed: 3,
          }}
        />,
      );

      expect(screen.getByTestId("tab-inbox")).toHaveTextContent(
        `Inbox${expectedCount}`,
      );
      expect(screen.getByTestId("tab-inbox")).not.toHaveTextContent(
        "53261",
      );
    },
  );

  it("clicking Outbox pushes ?tab=outbox to the router (test 8)", async () => {
    replaceCalls.length = 0;
    pushCalls.length = 0;
    const user = userEvent.setup();
    render(<CockpitView {...baseProps} activeTab="inbox" />);

    await user.click(screen.getByTestId("tab-outbox"));

    // Tabs is controlled by `activeTab` prop (server-derived). Clicking
    // the trigger calls router.replace; the actual aria-selected flip
    // happens on the next page render after the URL round-trip — that
    // hop is browser-level and stays in Playwright (test 32 in the
    // deep-link spec covers the activeTab='outbox' render).
    expect(replaceCalls).toContain("/messages?tab=outbox");
  });

  it("acknowledges a slow inbox filter immediately and clears when server rows arrive", async () => {
    replaceCalls.length = 0;
    pushCalls.length = 0;
    const user = userEvent.setup();
    const { rerender } = render(
      <CockpitView {...baseProps} activeTab="inbox" />,
    );

    const noOwner = screen.getByTestId("filter-unassigned");
    const results = screen.getByTestId("inbox-filter-results");
    await user.click(noOwner);

    expect(pushCalls).toEqual(["/messages?filter=unassigned"]);
    expect(noOwner).toHaveAttribute("aria-pressed", "true");
    expect(noOwner).toHaveAttribute("aria-busy", "true");
    expect(noOwner).toHaveAttribute("aria-disabled", "true");
    expect(noOwner).not.toBeDisabled();
    expect(screen.getByTestId("filter-all")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("filter-all")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByTestId("dnc-toggle")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(noOwner).not.toHaveAttribute("data-loading-muted");
    expect(screen.getByTestId("filter-all")).toHaveAttribute(
      "data-loading-muted",
      "true",
    );
    expect(screen.getByTestId("filter-all")).toHaveClass(
      "bg-[#f5f5f4]",
      "text-[#a8a29e]",
      "cursor-default",
    );
    expect(screen.getByTestId("dnc-toggle")).toHaveClass("opacity-50");
    expect(
      screen.queryByTestId("filter-unassigned-spinner"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading No owner messages",
    );
    expect(results).toHaveAttribute("aria-busy", "true");
    expect(results).toHaveClass("ring-0");
    expect(results).not.toHaveClass("cursor-wait");

    // The loading chip ignores duplicate clicks while the first server
    // navigation is still pending.
    await user.click(noOwner);
    expect(pushCalls).toHaveLength(1);

    rerender(
      <CockpitView {...baseProps} activeTab="inbox" filter="unassigned" />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("filter-unassigned")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(
      screen.queryByTestId("filter-unassigned-spinner"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(screen.getByTestId("inbox-filter-results")).toHaveClass("ring-0");
    expect(screen.getByTestId("filter-all")).not.toHaveAttribute(
      "data-loading-muted",
    );
    expect(screen.getByTestId("inbox-filter-results")).not.toHaveAttribute(
      "inert",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "No owner messages loaded",
    );
  });

  it("locks filter controls while pending and cancels feedback on navigation", async () => {
    replaceCalls.length = 0;
    pushCalls.length = 0;
    const user = userEvent.setup();
    const { rerender } = render(
      <CockpitView {...baseProps} activeTab="inbox" />,
    );

    await user.click(screen.getByTestId("filter-unassigned"));
    expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute("inert");

    await user.click(screen.getByTestId("dnc-toggle"));
    expect(pushCalls).toEqual(["/messages?filter=unassigned"]);
    expect(screen.queryByTestId("filter-unassigned-spinner")).toBeNull();
    expect(screen.queryByTestId("dnc-toggle-spinner")).toBeNull();
    expect(screen.getByTestId("dnc-toggle")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading No owner messages",
    );

    rerender(
      <CockpitView {...baseProps} activeTab="inbox" filter="unassigned" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "No owner messages loaded",
    );

    await user.click(screen.getByTestId("dnc-toggle"));
    expect(screen.queryByTestId("dnc-toggle-spinner")).toBeNull();
    expect(screen.getByTestId("dnc-toggle")).toHaveClass("opacity-50");
    expect(screen.getByTestId("filter-all")).toHaveAttribute(
      "data-loading-muted",
      "true",
    );
    expect(pushCalls).toHaveLength(2);

    // A click on the already-active chip cannot replace the DNC marker
    // and falsely end its loading feedback before the server catches up.
    await user.click(screen.getByTestId("filter-unassigned"));
    expect(pushCalls).toHaveLength(2);
    expect(screen.queryByTestId("dnc-toggle-spinner")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Updating DNC visibility",
    );

    rerender(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        filter="unassigned"
        hideDnc={false}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("dnc-toggle")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "DNC visibility updated",
    );

    await user.click(screen.getByTestId("filter-all"));
    await user.click(screen.getByTestId("tab-outbox"));
    expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
      "aria-busy",
      "false",
    );

    rerender(
      <CockpitView
        {...baseProps}
        activeTab="outbox"
        filter="unassigned"
        hideDnc={false}
      />,
    );
    rerender(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        filter="unassigned"
        hideDnc={false}
      />,
    );
    expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
      "aria-busy",
      "false",
    );

    await user.click(screen.getByTestId("filter-all"));
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() =>
      expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
  });

  it("unlocks a timed-out filter request and leaves the stale inbox usable", () => {
    vi.useFakeTimers();
    try {
      render(<CockpitView {...baseProps} activeTab="inbox" />);

      act(() => screen.getByTestId("filter-unassigned").click());
      expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
        "inert",
      );

      act(() => vi.advanceTimersByTime(10_000));

      expect(screen.getByTestId("inbox-filter-results")).not.toHaveAttribute(
        "inert",
      );
      expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Filter update timed out. Try again.",
      );
      expect(screen.getByTestId("filter-all")).toHaveAttribute(
        "aria-disabled",
        "false",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps active-filter clicks able to close a thread and reset pagination", async () => {
    replaceCalls.length = 0;
    pushCalls.length = 0;
    searchParamsValue = "inboxPage=3&thread=thread-1";
    const user = userEvent.setup();
    try {
      const { rerender } = render(
        <CockpitView
          {...baseProps}
          activeTab="inbox"
          inboxPage={3}
          selectedThreadId="thread-1"
        />,
      );

      await user.click(screen.getByTestId("filter-all"));
      expect(pushCalls).toEqual(["/messages"]);
      expect(screen.queryByTestId("filter-all-spinner")).toBeNull();
      expect(screen.getByTestId("filter-unassigned")).toHaveAttribute(
        "data-loading-muted",
        "true",
      );

      rerender(
        <CockpitView
          {...baseProps}
          activeTab="inbox"
          inboxPage={1}
          selectedThreadId={null}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("filter-all")).toHaveAttribute(
          "aria-busy",
          "false",
        ),
      );
    } finally {
      searchParamsValue = "";
    }
  });

  it("adds user-selected inbox pages to browser history", async () => {
    replaceCalls.length = 0;
    pushCalls.length = 0;
    const user = userEvent.setup();
    render(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        inboxPage={1}
        inboxPageSize={200}
        inboxTotal={201}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(pushCalls).toEqual(["/messages?inboxPage=2"]);
    expect(replaceCalls).toEqual([]);
  });

  it("Outbox tab renders the queue panel cadence controls (regression guard, test 13)", () => {
    render(<CockpitView {...baseProps} activeTab="outbox" />);

    // Auto-send button label and Cadence input both live in QueuePanel.
    // Either is sufficient to prove the panel mounted with its controls.
    expect(
      screen.getByRole("button", { name: /Auto-send|Pause/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Cadence/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Send next/i }),
    ).toBeInTheDocument();
  });
});
