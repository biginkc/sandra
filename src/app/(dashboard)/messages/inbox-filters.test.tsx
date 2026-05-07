import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CockpitView } from "./cockpit-view";
import type { Thread } from "@/lib/messages/list-threads";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/messages",
}));

vi.mock("./actions", () => ({
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

function makeThread(overrides: Partial<Thread> & { contactId: string }): Thread {
  return {
    contactId: overrides.contactId,
    contactName: overrides.contactName ?? `Contact ${overrides.contactId}`,
    contactPhone: overrides.contactPhone ?? "+15551234567",
    propertyId: overrides.propertyId ?? `prop-${overrides.contactId}`,
    propertyAddress: overrides.propertyAddress ?? "123 Main St",
    lastMessageAt: overrides.lastMessageAt ?? "2026-04-29T12:00:00Z",
    lastMessageBody: overrides.lastMessageBody ?? "hello",
    lastMessageDirection: overrides.lastMessageDirection ?? "inbound",
    unreadCount: overrides.unreadCount ?? 0,
    assigneeId: overrides.assigneeId ?? null,
  } as Thread;
}

const baseProps = {
  activeTab: "inbox" as const,
  queued: [],
  threadDetail: null,
  unknownSenders: [],
  unknownActiveCount: 0,
  assigneeEmails: {},
  currentUserId: "user-1",
  queueStats: {
    queued: 0,
    sentToday: 0,
    failedToday: 0,
    nextScheduledFor: null,
    lastScheduledFor: null,
  },
  hideDnc: true,
  hiddenDncCount: 0,
};

describe("<CockpitView /> assignment chips", () => {
  it("Mine chip is active and only mine-assigned threads render when filter='mine'", () => {
    // The page-level Server Component does the actual filtering query
    // and passes the resulting set as `threads`. The RTL boundary here
    // is "given the server passed the mine-only set, the chip is active
    // and the list contains those rows + nothing else."
    const mine = makeThread({
      contactId: "mine-1",
      contactName: "Mine Thread",
      lastMessageBody: "this is mine",
      assigneeId: "user-1",
    });

    render(
      <CockpitView
        {...baseProps}
        filter="mine"
        threads={[mine]}
      />,
    );

    expect(screen.getByTestId("filter-mine")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("filter-all")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("filter-unassigned")).not.toHaveAttribute(
      "data-active",
    );

    expect(screen.getByTestId("inbox-thread-mine-1")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-thread-not-mine")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("inbox-thread-unassigned-1"),
    ).not.toBeInTheDocument();
  });

  it("Unassigned chip is active and only unassigned threads render when filter='unassigned'", () => {
    const open = makeThread({
      contactId: "unassigned-1",
      contactName: "Open Thread",
      lastMessageBody: "claim me",
      assigneeId: null,
    });

    render(
      <CockpitView
        {...baseProps}
        filter="unassigned"
        threads={[open]}
      />,
    );

    expect(screen.getByTestId("filter-unassigned")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("filter-all")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("filter-mine")).not.toHaveAttribute("data-active");

    expect(screen.getByTestId("inbox-thread-unassigned-1")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-thread-mine-1")).not.toBeInTheDocument();
  });

  it("does not render Mine/Unassigned chips when there is no current user", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="all"
        threads={[]}
        currentUserId={null}
      />,
    );

    expect(screen.getByTestId("filter-all")).toBeInTheDocument();
    expect(screen.queryByTestId("filter-mine")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-unassigned")).not.toBeInTheDocument();
  });
});

describe("<CockpitView /> DNC toggle", () => {
  it("renders the toggle in active (hidden) state by default", () => {
    render(<CockpitView {...baseProps} filter="all" threads={[]} />);
    const toggle = screen.getByTestId("dnc-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("data-active", "true");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveTextContent("Hide DNC");
  });

  it("renders OFF state with 'Showing DNC' label when hideDnc=false", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="all"
        threads={[]}
        hideDnc={false}
      />,
    );
    const toggle = screen.getByTestId("dnc-toggle");
    expect(toggle).not.toHaveAttribute("data-active");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveTextContent("Showing DNC");
  });

  it("shows hidden-count hint when hideDnc=true and DNC threads exist", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="all"
        threads={[]}
        hideDnc={true}
        hiddenDncCount={4}
      />,
    );
    const count = screen.getByTestId("dnc-toggle-count");
    expect(count).toHaveTextContent("(4 hidden)");
  });

  it("does not show count hint when hiddenDncCount is zero", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="all"
        threads={[]}
        hideDnc={true}
        hiddenDncCount={0}
      />,
    );
    expect(screen.queryByTestId("dnc-toggle-count")).not.toBeInTheDocument();
  });

  it("does not show count hint when hideDnc=false (DNC visible inline)", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="all"
        threads={[]}
        hideDnc={false}
        hiddenDncCount={3}
      />,
    );
    expect(screen.queryByTestId("dnc-toggle-count")).not.toBeInTheDocument();
  });
});
