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
  unknownActiveCount: 0,
  needsOutcomeCount: 0,
  unreadCount: 0,
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

    expect(screen.getByTestId(`inbox-thread-${mine.threadId}`)).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-thread-not-mine")).not.toBeInTheDocument();
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

    expect(screen.getByTestId(`inbox-thread-${open.threadId}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`inbox-thread-conv-mine-1`)).not.toBeInTheDocument();
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
    expect(toggle).toHaveTextContent("Showing all");
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
      screen.queryByTestId("inbox-thread-legacy:done-1:prop-done-1-needs-outcome"),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["sent", null, "Sandra handled. SMS sent", "border-[#d1fae5]"],
    ["delivered", null, "Sandra handled. SMS delivered", "border-[#d1fae5]"],
    ["failed", null, "Sandra handled. SMS failed", "border-[#fecaca]"],
    [
      "failed",
      "Carrier rejected recipient",
      "Sandra handled. SMS failed: Carrier rejected recipient",
      "border-[#fecaca]",
    ],
  ] as const)(
    "renders Sandra handled %s as an icon-only marker",
    (deliveryStatus, deliveryError, label, borderClass) => {
      const thread = makeThread({
        contactId: `handled-${deliveryStatus}-${deliveryError ?? "none"}`,
        threadId: `conv-handled-${deliveryStatus}-${deliveryError ?? "none"}`,
        aiResponderStatus: "handled",
        aiLastDeliveryStatus: deliveryStatus,
        aiLastDeliveryError: deliveryError,
      });

      render(<CockpitView {...baseProps} filter="all" threads={[thread]} />);

      const status = screen.getByTestId(`inbox-thread-${thread.threadId}-sandra-status`);
      expect(status).not.toHaveTextContent("Sandra handled");
      expect(status.querySelector("img")).toHaveAttribute("src", "/icon.png");
      expect(status).toHaveAccessibleName(label);
      expect(status).toHaveAttribute("title", label);
      expect(status).toHaveClass(borderClass);
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

    const status = screen.getByTestId("inbox-thread-conv-escalated-1-sandra-status");
    expect(status).not.toHaveTextContent("Sandra escalated");
    expect(status.querySelector("img")).toHaveAttribute("src", "/icon.png");
    expect(status).toHaveAccessibleName("Sandra escalated");
    expect(status).toHaveClass("border-[#fed7aa]");
  });

  it("renders chips in priority order: Unread, Needs Outcome, Mine, Sandra Escalated, Dispo, then the rest", () => {
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
    expect(screen.getByTestId("filter-escalated").querySelector("img")).toHaveAttribute(
      "src",
      "/icon.png",
    );
    expect(screen.getByTestId("filter-dispo").querySelector("img")).toHaveAttribute(
      "src",
      "/icon.png",
    );
    expect(screen.getByTestId("filter-dispo")).toHaveTextContent("Dispo");
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
        needsOutcomeCount={3}
        threads={[]}
      />,
    );

    const chip = screen.getByTestId("filter-needs-outcome");
    expect(chip).toHaveAttribute("data-active", "true");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveTextContent("Needs Outcome");
    expect(chip).toHaveTextContent("3");
  });

  it("keeps count badges visible on inactive filter labels", () => {
    render(
      <CockpitView
        {...baseProps}
        filter="all"
        threads={[]}
        unreadCount={2}
        needsOutcomeCount={3}
        unknownActiveCount={4}
      />,
    );

    const unread = screen.getByTestId("filter-unread");
    const needsOutcome = screen.getByTestId("filter-needs-outcome");
    const unknown = screen.getByTestId("filter-unknown");

    expect(unread).not.toHaveAttribute("data-active");
    expect(unread).toHaveAttribute("aria-pressed", "false");
    expect(unread).toHaveTextContent("Unread");
    expect(unread).toHaveTextContent("2");

    expect(needsOutcome).not.toHaveAttribute("data-active");
    expect(needsOutcome).toHaveAttribute("aria-pressed", "false");
    expect(needsOutcome).toHaveTextContent("Needs Outcome");
    expect(needsOutcome).toHaveTextContent("3");

    expect(unknown).not.toHaveAttribute("data-active");
    expect(unknown).toHaveAttribute("aria-pressed", "false");
    expect(unknown).toHaveTextContent("Unknown");
    expect(unknown).toHaveTextContent("4");
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

  it("Dispo chip is active and renders dispositioned threads", () => {
    const dispo = makeThread({
      contactId: "dispo-2",
      contactName: "Dispo Thread",
      outreachDispo: "not_interested",
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
