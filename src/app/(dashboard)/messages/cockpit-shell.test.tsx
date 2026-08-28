import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CockpitView } from "./cockpit-view";
import type { InboxFilterCounts } from "./inbox-filters";

const replaceCalls: string[] = [];

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn((url: string) => {
      replaceCalls.push(url);
    }),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
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

  it("clicking Outbox pushes ?tab=outbox to the router (test 8)", async () => {
    replaceCalls.length = 0;
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
    const user = userEvent.setup();
    const { rerender } = render(
      <CockpitView {...baseProps} activeTab="inbox" />,
    );

    const noOwner = screen.getByTestId("filter-unassigned");
    const results = screen.getByTestId("inbox-filter-results");
    await user.click(noOwner);

    expect(replaceCalls).toEqual(["/messages?filter=unassigned"]);
    expect(noOwner).toHaveAttribute("aria-pressed", "true");
    expect(noOwner).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("filter-all")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("filter-unassigned-spinner")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading No owner messages",
    );
    expect(results).toHaveAttribute("aria-busy", "true");
    expect(results).toHaveClass("ring-1");

    // The loading chip ignores duplicate clicks while the first server
    // navigation is still pending.
    await user.click(noOwner);
    expect(replaceCalls).toHaveLength(1);

    rerender(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        filter="unassigned"
      />,
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
  });

  it("replaces or cancels pending feedback when the operator changes direction", async () => {
    replaceCalls.length = 0;
    const user = userEvent.setup();
    const { rerender } = render(
      <CockpitView {...baseProps} activeTab="inbox" />,
    );

    await user.click(screen.getByTestId("filter-unassigned"));
    expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
      "inert",
    );

    await user.click(screen.getByTestId("dnc-toggle"));
    expect(screen.queryByTestId("filter-unassigned-spinner")).toBeNull();
    expect(screen.getByTestId("dnc-toggle-spinner")).toBeVisible();
    expect(screen.getByTestId("dnc-toggle")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Updating DNC visibility",
    );

    rerender(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        hideDnc={false}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );

    await user.click(screen.getByTestId("filter-unassigned"));
    await user.click(screen.getByTestId("tab-outbox"));
    expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
      "aria-busy",
      "false",
    );

    rerender(
      <CockpitView
        {...baseProps}
        activeTab="outbox"
        hideDnc={false}
      />,
    );
    rerender(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        hideDnc={false}
      />,
    );
    expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
      "aria-busy",
      "false",
    );

    await user.click(screen.getByTestId("filter-unassigned"));
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() =>
      expect(screen.getByTestId("inbox-filter-results")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
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
