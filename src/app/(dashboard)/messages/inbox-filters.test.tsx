import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CockpitView } from "./cockpit-view";
import type { Thread } from "@/lib/messages/list-threads";
import type { InboxFilterCounts } from "./inbox-filters";

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

function makeThread(
  overrides: Partial<Thread> & { contactId: string },
): Thread {
  const propertyId = overrides.propertyId ?? `prop-${overrides.contactId}`;
  return {
    threadId: overrides.threadId ?? `conv-${overrides.contactId}`,
    contactId: overrides.contactId,
    contactName: overrides.contactName ?? `Contact ${overrides.contactId}`,
    contactPhone: overrides.contactPhone ?? "+15551234567",
    propertyId,
    propertyAddress: overrides.propertyAddress ?? "123 Main St",
    propertyStatus: overrides.propertyStatus ?? "prospect",
    outreachDispo: overrides.outreachDispo ?? null,
    aiDispositionReview: overrides.aiDispositionReview ?? null,
    isDncLocked: overrides.isDncLocked ?? false,
    lastMessageAt: overrides.lastMessageAt ?? "2026-04-29T12:00:00Z",
    lastMessageBody: overrides.lastMessageBody ?? "hello",
    lastMessageDirection: overrides.lastMessageDirection ?? "inbound",
    unreadCount: overrides.unreadCount ?? 0,
    assigneeId: overrides.assigneeId ?? null,
    needsHumanAttention: overrides.needsHumanAttention ?? false,
    escalationReason: overrides.escalationReason ?? null,
    isOptedOut: overrides.isOptedOut ?? false,
    isTestTraffic: overrides.isTestTraffic ?? false,
    needsOutcome: overrides.needsOutcome ?? false,
    aiResponderStatus: overrides.aiResponderStatus ?? null,
    aiResponderReason: overrides.aiResponderReason ?? null,
    aiResponderStatusAt: overrides.aiResponderStatusAt ?? null,
    aiLastDeliveryStatus: overrides.aiLastDeliveryStatus ?? null,
    aiLastDeliveryError: overrides.aiLastDeliveryError ?? null,
  } as Thread;
}

const baseProps = {
  activeTab: "inbox" as const,
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

    render(<CockpitView {...baseProps} filter="mine" threads={[mine]} />);

    expect(screen.getByTestId("filter-mine")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("filter-all")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("filter-unassigned")).not.toHaveAttribute(
      "data-active",
    );

    expect(
      screen.getByTestId(`inbox-thread-${mine.threadId}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("inbox-thread-not-mine"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`inbox-thread-conv-unassigned-1`),
    ).not.toBeInTheDocument();
  });

  it("Unassigned chip is active and only unassigned threads render when filter='unassigned'", () => {
    const open = makeThread({
      contactId: "unassigned-1",
      contactName: "Open Thread",
      lastMessageBody: "claim me",
      assigneeId: null,
    });

    render(<CockpitView {...baseProps} filter="unassigned" threads={[open]} />);

    expect(screen.getByTestId("filter-unassigned")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("filter-all")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("filter-mine")).not.toHaveAttribute(
      "data-active",
    );

    expect(
      screen.getByTestId(`inbox-thread-${open.threadId}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`inbox-thread-conv-mine-1`),
    ).not.toBeInTheDocument();
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
    expect(toggle).toHaveTextContent("Hide DNC & tests");
  });

  it("renders OFF state with 'Showing all' label when hideDnc=false", () => {
    render(
      <CockpitView {...baseProps} filter="all" threads={[]} hideDnc={false} />,
    );
    const toggle = screen.getByTestId("dnc-toggle");
    expect(toggle).not.toHaveAttribute("data-active");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveTextContent("Showing all");
  });

  it("explains the fixed compliance visibility rule on Sandra Dispo", () => {
    render(
      <CockpitView {...baseProps} filter="dispo" threads={[]} hideDnc={true} />,
    );

    expect(screen.queryByTestId("dnc-toggle")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("sandra-dispo-compliance-note"),
    ).toHaveTextContent("Compliance reviews shown · tests hidden");
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

describe("<CockpitView /> chip order (feedback-f E2b)", () => {
  it("renders a needs-outcome dot on threads that need an outcome", () => {
    const thread = makeThread({
      contactId: "needs-1",
      threadId: "legacy:needs-1:prop-needs-1",
      needsOutcome: true,
    });

    render(<CockpitView {...baseProps} filter="all" threads={[thread]} />);

    const dot = screen.getByTestId(
      "inbox-thread-legacy:needs-1:prop-needs-1-needs-outcome",
    );
    expect(dot).toHaveAccessibleName("Needs outcome");
    expect(dot).toHaveAttribute("title", "Needs outcome");
    expect(dot).toHaveClass("bg-[#f59e0b]");
    expect(dot).toBeEmptyDOMElement();
  });

  it("does not render the needs-outcome dot once the thread has an outcome", () => {
    const thread = makeThread({
      contactId: "done-1",
      threadId: "legacy:done-1:prop-done-1",
      needsOutcome: false,
      outreachDispo: "not_interested",
    });

    render(<CockpitView {...baseProps} filter="all" threads={[thread]} />);

    expect(
      screen.queryByTestId(
        "inbox-thread-legacy:done-1:prop-done-1-needs-outcome",
      ),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["sent", null, "Sandra handled. SMS sent", "bg-[#10b981]"],
    ["delivered", null, "Sandra handled. SMS delivered", "bg-[#10b981]"],
    ["failed", null, "Sandra handled. SMS failed", "bg-[#ef4444]"],
    [
      "failed",
      "Carrier rejected recipient",
      "Sandra handled. SMS failed: Carrier rejected recipient",
      "bg-[#ef4444]",
    ],
  ] as const)(
    "renders Sandra handled %s as an icon-only marker",
    (deliveryStatus, deliveryError, label, dotClass) => {
      const thread = makeThread({
        contactId: `handled-${deliveryStatus}-${deliveryError ?? "none"}`,
        threadId: `conv-handled-${deliveryStatus}-${deliveryError ?? "none"}`,
        aiResponderStatus: "handled",
        aiLastDeliveryStatus: deliveryStatus,
        aiLastDeliveryError: deliveryError,
      });

      render(<CockpitView {...baseProps} filter="all" threads={[thread]} />);

      const status = screen.getByTestId(
        `inbox-thread-${thread.threadId}-sandra-status`,
      );
      expect(status).not.toHaveTextContent("Sandra handled");
      expect(status.querySelector("img")).toHaveAttribute("src", "/icon.png");
      expect(status).toHaveAccessibleName(label);
      expect(status).toHaveAttribute("title", label);
      expect(status).not.toHaveClass("rounded-full");
      expect(status).not.toHaveClass("border");
      expect(
        screen.getByTestId(`inbox-thread-${thread.threadId}-sandra-status-dot`),
      ).toHaveClass(dotClass);
      expect(
        screen.queryByTestId(`inbox-thread-${thread.threadId}-sandra-delivery`),
      ).not.toBeInTheDocument();
    },
  );

  it("renders Sandra escalated status as icon-only", () => {
    const thread = makeThread({
      contactId: "escalated-1",
      threadId: "conv-escalated-1",
      aiResponderStatus: "escalated",
    });

    render(<CockpitView {...baseProps} filter="all" threads={[thread]} />);

    const status = screen.getByTestId(
      "inbox-thread-conv-escalated-1-sandra-status",
    );
    expect(status).not.toHaveTextContent("Sandra escalated");
    expect(status.querySelector("img")).toHaveAttribute("src", "/icon.png");
    expect(status).toHaveAccessibleName("Sandra escalated");
    expect(status).not.toHaveClass("rounded-full");
    expect(status).not.toHaveClass("border");
    expect(
      screen.getByTestId("inbox-thread-conv-escalated-1-sandra-status-dot"),
    ).toHaveClass("bg-[#f59e0b]");
  });

  it("renders chips in priority order: Unread, Needs Outcome, Mine, Sandra Escalated, Sandra Dispo, then the rest", () => {
    render(<CockpitView {...baseProps} filter="all" threads={[]} />);

    const chips = screen
      .getByTestId("inbox-filters")
      .querySelectorAll("[data-testid^='filter-']");
    const ids = Array.from(chips).map((c) => c.getAttribute("data-testid"));

    expect(ids).toEqual([
      "filter-unread",
      "filter-needs-outcome",
      "filter-mine",
      "filter-escalated",
      "filter-dispo",
      "filter-unassigned",
      "filter-all",
      "filter-unknown",
      "filter-dismissed",
    ]);
    expect(
      screen.getByTestId("filter-escalated").querySelector("img"),
    ).toHaveAttribute("src", "/icon.png");
    expect(
      screen.getByTestId("filter-dispo").querySelector("img"),
    ).toHaveAttribute("src", "/icon.png");
    expect(screen.getByTestId("filter-dispo")).toHaveTextContent(
      "Sandra Dispo",
    );
    expect(screen.queryByTestId("filter-handled")).not.toBeInTheDocument();
  });

  it("when no current user, chip order collapses without Mine/Unassigned", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="all"
        threads={[]}
        currentUserId={null}
      />,
    );

    const chips = screen
      .getByTestId("inbox-filters")
      .querySelectorAll("[data-testid^='filter-']");
    const ids = Array.from(chips).map((c) => c.getAttribute("data-testid"));

    expect(ids).toEqual([
      "filter-unread",
      "filter-needs-outcome",
      "filter-escalated",
      "filter-dispo",
      "filter-all",
      "filter-unknown",
      "filter-dismissed",
    ]);
  });

  it("shows Needs Outcome as active with a count badge", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="needs_outcome"
        filterCounts={{ ...baseProps.filterCounts, needs_outcome: 3 }}
        threads={[]}
      />,
    );

    const chip = screen.getByTestId("filter-needs-outcome");
    expect(chip).toHaveAttribute("data-active", "true");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveAccessibleName("Needs Outcome (3)");
    expect(chip).toHaveTextContent("Needs Outcome");
    expect(chip).toHaveTextContent("3");
    expect(screen.getByTestId("filter-needs-outcome-count")).toHaveTextContent(
      "3",
    );
  });

  it("keeps count badges visible on inactive filter labels", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="all"
        threads={[]}
        filterCounts={{
          ...baseProps.filterCounts,
          all: 9,
          mine: 2,
          unassigned: 1,
          unread: 2,
          needs_outcome: 3,
          escalated: 4,
          dispo: 5,
          unknown: 6,
          dismissed: 7,
        }}
      />,
    );

    const unread = screen.getByTestId("filter-unread");
    const needsOutcome = screen.getByTestId("filter-needs-outcome");
    const mine = screen.getByTestId("filter-mine");
    const escalated = screen.getByTestId("filter-escalated");
    const dispo = screen.getByTestId("filter-dispo");
    const unassigned = screen.getByTestId("filter-unassigned");
    const all = screen.getByTestId("filter-all");
    const unknown = screen.getByTestId("filter-unknown");
    const dismissed = screen.getByTestId("filter-dismissed");

    expect(unread).not.toHaveAttribute("data-active");
    expect(unread).toHaveAttribute("aria-pressed", "false");
    expect(unread).toHaveAccessibleName("Unread (2)");
    expect(unread).toHaveTextContent("Unread");
    expect(unread).toHaveTextContent("2");

    expect(needsOutcome).not.toHaveAttribute("data-active");
    expect(needsOutcome).toHaveAttribute("aria-pressed", "false");
    expect(needsOutcome).toHaveTextContent("Needs Outcome");
    expect(needsOutcome).toHaveTextContent("3");

    expect(mine).toHaveTextContent("Mine");
    expect(mine).toHaveTextContent("2");
    expect(escalated).toHaveTextContent("Escalated");
    expect(escalated).toHaveTextContent("4");
    expect(dispo).toHaveTextContent("Sandra Dispo");
    expect(dispo).toHaveTextContent("5");
    expect(unassigned).toHaveTextContent("No owner");
    expect(unassigned).toHaveTextContent("1");
    expect(all).toHaveTextContent("All");
    expect(all).toHaveTextContent("9");
    expect(unknown).not.toHaveAttribute("data-active");
    expect(unknown).toHaveAttribute("aria-pressed", "false");
    expect(unknown).toHaveAccessibleName("Unknown (6)");
    expect(unknown).toHaveTextContent("Unknown");
    expect(unknown).toHaveTextContent("6");
    expect(dismissed).toHaveTextContent("Dismissed");
    expect(dismissed).toHaveTextContent("7");
  });

  it("hides zero-count badges on all filters", () => {
    render(<CockpitView {...baseProps} filter="all" threads={[]} />);

    for (const id of [
      "filter-unread",
      "filter-needs-outcome",
      "filter-mine",
      "filter-escalated",
      "filter-dispo",
      "filter-unassigned",
      "filter-all",
      "filter-unknown",
      "filter-dismissed",
    ]) {
      expect(screen.queryByTestId(`${id}-count`)).not.toBeInTheDocument();
    }
  });

  it("keeps Unknown and Dismissed primary controls at least 44px tall", () => {
    const sender = {
      fromAddress: "+15550009999",
      toAddress: "+18162804181",
      latestBody: "Who is this?",
      latestAt: "2026-08-17T11:00:00.000Z",
      messageCount: 1,
      isDismissed: false,
    };
    const view = render(
      <CockpitView
        {...baseProps}
        filter="unknown"
        threads={[]}
        unknownSenders={[sender]}
      />,
    );

    expect(screen.getByTestId("filter-unknown")).toHaveClass("min-h-11");
    expect(screen.getByTestId("filter-dismissed")).toHaveClass("min-h-11");
    expect(screen.getByTestId("unknown-view-thread-+15550009999")).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
    expect(screen.getByTestId("unknown-actions-+15550009999")).toHaveClass(
      "min-h-11",
    );

    view.rerender(
      <CockpitView
        {...baseProps}
        filter="dismissed"
        threads={[]}
        unknownSenders={[{ ...sender, isDismissed: true }]}
      />,
    );
    expect(screen.getByTestId("unknown-restore-+15550009999")).toHaveClass(
      "min-h-11",
    );
  });
});

describe("<CockpitView /> escalated chip", () => {
  it("Escalated chip is active and only escalated threads render when filter='escalated'", () => {
    // Mirrors the Mine/Unassigned contract: the page-level Server Component
    // runs the Sandra escalated query and passes that set as `threads`.
    // Here we assert the chip is active and the handed-off rows render.
    const escalated = makeThread({
      contactId: "esc-1",
      contactName: "Escalated Thread",
      lastMessageBody: "I want to talk to a person",
      aiResponderStatus: "escalated",
      aiResponderReason: "keyword:handoff_request",
    });

    render(
      <CockpitView {...baseProps} filter="escalated" threads={[escalated]} />,
    );

    expect(screen.getByTestId("filter-escalated")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("filter-all")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("filter-unread")).not.toHaveAttribute(
      "data-active",
    );

    expect(
      screen.getByTestId(`inbox-thread-${escalated.threadId}`),
    ).toBeInTheDocument();
  });

  it("renders the Escalated chip even when no current user is present", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="all"
        threads={[]}
        currentUserId={null}
      />,
    );
    expect(screen.getByTestId("filter-escalated")).toBeInTheDocument();
  });

  it("Sandra Dispo chip is active and renders pending AI review threads", () => {
    const dispo = makeThread({
      contactId: "dispo-2",
      contactName: "Dispo Thread",
      outreachDispo: "not_interested",
      aiDispositionReview: {
        id: "review-filter",
        status: "pending",
        disposition: "not_interested",
        reason: "AI classified reply",
        sourceInboundMessageId: "message-filter",
        createdAt: "2026-08-27T14:00:00.000Z",
      },
    });

    render(<CockpitView {...baseProps} filter="dispo" threads={[dispo]} />);

    expect(screen.getByTestId("filter-dispo")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.queryByTestId("filter-handled")).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`inbox-thread-${dispo.threadId}`),
    ).toBeInTheDocument();
  });
});
