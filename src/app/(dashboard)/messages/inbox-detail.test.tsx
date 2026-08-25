import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, it, expect, vi } from "vitest";

import { InboxDetail } from "./inbox-detail";
import type { InboxDetail as InboxDetailData } from "./inbox-detail-data";
import { sendSmsFromLead } from "../leads/actions";
import type { Database } from "@/lib/supabase/types";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

// In-test holder for the most recent router-replace destination so the
// ESC-closes-and-clears-?thread test can assert on the URL the panel
// would push.
const replaceCalls: string[] = [];
const refreshCalls: number[] = [];
const pushCalls: string[] = [];
const setOutreachDispoMock = vi.hoisted(() => vi.fn());
const moveMessageThreadToLeadMock = vi.hoisted(() => vi.fn());
const supabaseMock = vi.hoisted(() => {
  const subscriptions: Array<{
    type: string;
    filter: Record<string, unknown>;
    callback: (payload: { new: MessageRow }) => void;
  }> = [];
  const channel = {
    on: vi.fn(
      (
        type: string,
        filter: Record<string, unknown>,
        callback: (payload: { new: MessageRow }) => void,
      ) => {
        subscriptions.push({ type, filter, callback });
        return channel;
      },
    ),
    subscribe: vi.fn(() => channel),
  };
  return {
    subscriptions,
    client: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: null } })),
      },
      realtime: {
        setAuth: vi.fn(),
      },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn((url: string) => {
      pushCalls.push(url);
    }),
    replace: vi.fn((url: string) => {
      replaceCalls.push(url);
    }),
    refresh: vi.fn(() => {
      refreshCalls.push(Date.now());
    }),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/messages",
}));

vi.mock("./dispo-actions", () => ({
  setOutreachDispo: setOutreachDispoMock,
  moveMessageThreadToLead: moveMessageThreadToLeadMock,
}));

// Server-action modules ("use server" at top) cannot be imported in jsdom —
// they pull in next/server's `after` and the Supabase server client.
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

// MessagesThread + InboxThreadList both subscribe to Supabase Realtime on
// mount. Stub the browser client so the channel pipeline is a no-op.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => supabaseMock.client,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

function makeMessage(
  overrides: Partial<MessageRow> & {
    id: string;
    body: string;
    direction: "inbound" | "outbound";
  },
): MessageRow {
  return {
    id: overrides.id,
    body: overrides.body,
    direction: overrides.direction,
    status:
      overrides.status ??
      (overrides.direction === "inbound" ? "received" : "sent"),
    channel: "sms",
    contact_id: overrides.contact_id ?? "contact-1",
    property_id: overrides.property_id ?? "prop-1",
    conversation_id:
      overrides.conversation_id ??
      `conv-${overrides.contact_id ?? "contact-1"}`,
    from_address:
      overrides.direction === "inbound" ? "+15551234567" : "+18162804181",
    to_address:
      overrides.direction === "inbound" ? "+18162804181" : "+15551234567",
    created_at: overrides.created_at ?? "2026-04-29T12:00:00Z",
    read_at: overrides.read_at ?? null,
    metadata: overrides.metadata ?? null,
    // The schema has additional columns that are nullable for our
    // purposes — the cast keeps the test focused on what the panel
    // actually reads.
  } as MessageRow;
}

function makeData(
  overrides: Partial<InboxDetailData> & { contactId: string },
): InboxDetailData {
  const contactId = overrides.contactId;
  const propertyId = Object.hasOwn(overrides, "propertyId")
    ? overrides.propertyId!
    : "prop-1";
  return {
    threadId: overrides.threadId ?? `conv-${contactId}`,
    conversationId: overrides.conversationId ?? `conv-${contactId}`,
    contactId,
    contactName: overrides.contactName ?? "Panel Test",
    threadCustomerPhone: overrides.threadCustomerPhone ?? "+15551234567",
    threadBusinessPhone: overrides.threadBusinessPhone ?? "+18162804181",
    contactPhone: overrides.contactPhone ?? "+15551234567",
    replyToPhone: Object.hasOwn(overrides, "replyToPhone")
      ? overrides.replyToPhone!
      : "+15551234567",
    propertyId,
    propertyAddress: Object.hasOwn(overrides, "propertyAddress")
      ? overrides.propertyAddress!
      : "123 Main St, Albany, NY",
    homeownerContactId: Object.hasOwn(overrides, "homeownerContactId")
      ? overrides.homeownerContactId!
      : contactId,
    agentContactId: overrides.agentContactId ?? null,
    assigneeId: overrides.assigneeId ?? null,
    propertyStatus: overrides.propertyStatus ?? "prospect",
    outreachDispo: overrides.outreachDispo ?? null,
    contactDoNotContact: overrides.contactDoNotContact ?? false,
    contactSmsOptedOut: overrides.contactSmsOptedOut ?? false,
    smsConsentState: Object.hasOwn(overrides, "smsConsentState")
      ? overrides.smsConsentState!
      : "can_send_marketing",
    phoneSuppressed: Object.hasOwn(overrides, "phoneSuppressed")
      ? overrides.phoneSuppressed!
      : false,
    smsSafetyReadFailed: overrides.smsSafetyReadFailed ?? false,
    isDncLocked: overrides.isDncLocked ?? false,
    initialMessages: overrides.initialMessages ?? [],
  };
}

function expectSharedOutcomeControls({
  moveToLeadDisabled,
}: {
  moveToLeadDisabled: boolean;
}) {
  expect(screen.getByTestId("dispo-wrong-number")).toHaveTextContent(
    "Wrong number",
  );
  expect(screen.getByTestId("dispo-not-interested")).toBeInTheDocument();
  expect(screen.getByTestId("dispo-follow-up")).toHaveTextContent("Follow up");
  expect(screen.getByTestId("dispo-dnc-deferred")).toHaveTextContent(
    "Permanent DNC unavailable here",
  );
  expect(screen.getByTestId("dispo-dnc-deferred")).toBeDisabled();
  expect(screen.getByTestId("dispo-needs-sequence")).toHaveTextContent(
    "Needs sequence",
  );
  expect(screen.getByTestId("dispo-more")).toBeInTheDocument();

  const moveToLead = screen.getByTestId("message-move-to-lead");
  if (moveToLeadDisabled) {
    expect(moveToLead).toBeDisabled();
  } else {
    expect(moveToLead).toBeEnabled();
  }
}

describe("<InboxDetail />", () => {
  beforeEach(() => {
    pushCalls.length = 0;
    replaceCalls.length = 0;
    refreshCalls.length = 0;
    setOutreachDispoMock.mockClear();
    moveMessageThreadToLeadMock.mockClear();
    setOutreachDispoMock.mockResolvedValue({ ok: true });
    moveMessageThreadToLeadMock.mockResolvedValue({
      ok: true,
      alreadyQualified: false,
    });
    supabaseMock.subscriptions.length = 0;
    supabaseMock.client.channel.mockClear();
    supabaseMock.client.removeChannel.mockClear();
    supabaseMock.client.auth.getSession.mockClear();
    supabaseMock.client.realtime.setAuth.mockClear();
    vi.mocked(sendSmsFromLead).mockReset();
    vi.mocked(sendSmsFromLead).mockResolvedValue({
      ok: true,
      data: {
        outcome: {
          status: "sent",
          messageId: "sent-reply-1",
          externalId: "mock_sent-reply-1",
        },
      },
    } as Awaited<ReturnType<typeof sendSmsFromLead>>);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => undefined),
      },
    });
  });

  it("renders the empty placeholder when no thread is selected (test 14 baseline)", () => {
    render(
      <InboxDetail data={null} assigneeEmails={{}} currentUserId="user-1" />,
    );
    expect(screen.getByTestId("inbox-detail-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-detail-panel")).not.toBeInTheDocument();
  });

  it("renders the side panel with conversation bubbles (tests 14 + 15)", () => {
    const data = makeData({
      contactId: "contact-1",
      initialMessages: [
        makeMessage({
          id: "m1",
          body: "first outbound",
          direction: "outbound",
          created_at: "2026-04-29T11:30:00Z",
        }),
        makeMessage({
          id: "m2",
          body: "first inbound",
          direction: "inbound",
          created_at: "2026-04-29T11:40:00Z",
        }),
      ],
    });

    const { container } = render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    const panel = screen.getByTestId("inbox-detail-panel");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent("first outbound");
    expect(panel).toHaveTextContent("first inbound");

    // Outbound bubble uses bg-primary, inbound uses bg-muted.
    expect(container.querySelector(".bg-primary")).not.toBeNull();
    expect(container.querySelector(".bg-muted")).not.toBeNull();
  });

  it("ESC closes the panel by clearing ?thread (test 16)", async () => {
    replaceCalls.length = 0;
    refreshCalls.length = 0;

    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-esc",
      initialMessages: [
        makeMessage({
          id: "m1",
          body: "open me",
          direction: "inbound",
        }),
      ],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.getByTestId("inbox-detail-panel")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    // The panel calls router.replace("/messages") (no query string left)
    // and router.refresh() to drop the side-panel data on the server
    // round-trip.
    expect(replaceCalls).toContain("/messages");
    expect(refreshCalls.length).toBeGreaterThan(0);
  });

  it("switching threads remounts MessagesThread with the new contact (test 17)", () => {
    const aData = makeData({
      contactId: "contact-a",
      contactName: "Contact A",
      initialMessages: [
        makeMessage({
          id: "ma",
          body: "hello from A",
          direction: "inbound",
          contact_id: "contact-a",
        }),
      ],
    });
    const bData = makeData({
      contactId: "contact-b",
      contactName: "Contact B",
      initialMessages: [
        makeMessage({
          id: "mb",
          body: "hello from B",
          direction: "inbound",
          contact_id: "contact-b",
        }),
      ],
    });

    const { rerender } = render(
      <InboxDetail data={aData} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.getByTestId("inbox-detail-panel")).toHaveTextContent(
      "hello from A",
    );

    rerender(
      <InboxDetail data={bData} assigneeEmails={{}} currentUserId="user-1" />,
    );

    const panel = screen.getByTestId("inbox-detail-panel");
    expect(panel).toHaveTextContent("hello from B");
    expect(panel).not.toHaveTextContent("hello from A");
  });

  it("switching threads for the same contact resets the inline reply draft", async () => {
    const user = userEvent.setup();
    const aData = makeData({
      contactId: "contact-a",
      propertyId: "prop-a",
      threadId: "conv-contact-a-prop-a",
      conversationId: "conv-contact-a-prop-a",
      initialMessages: [
        makeMessage({
          id: "ma",
          body: "hello from property A",
          direction: "inbound",
          contact_id: "contact-a",
          property_id: "prop-a",
        }),
      ],
    });
    const bData = makeData({
      contactId: "contact-a",
      propertyId: "prop-b",
      threadId: "conv-contact-a-prop-b",
      conversationId: "conv-contact-a-prop-b",
      initialMessages: [
        makeMessage({
          id: "mb",
          body: "hello from property B",
          direction: "inbound",
          contact_id: "contact-a",
          property_id: "prop-b",
        }),
      ],
    });

    const { rerender } = render(
      <InboxDetail data={aData} assigneeEmails={{}} currentUserId="user-1" />,
    );

    const textarea = screen.getByLabelText("Reply to this lead");
    await user.type(textarea, "draft for property A");
    expect(textarea).toHaveValue("draft for property A");

    rerender(
      <InboxDetail data={bData} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.getByLabelText("Reply to this lead")).toHaveValue("");
  });

  it("sends inline replies immediately to the same saved thread phone shown in Messages", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-reply-phone",
      propertyId: "prop-reply-phone",
      threadCustomerPhone: "+15550000002",
      contactPhone: "+15550000002",
      replyToPhone: "+15550000002",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.getByTestId("inline-reply")).toHaveTextContent(
      "+1 (555) 000-0002",
    );

    await user.type(screen.getByLabelText("Reply to this lead"), "Thanks");
    await user.click(screen.getByTestId("inline-reply-send"));

    await waitFor(() => {
      expect(sendSmsFromLead).toHaveBeenCalledWith(
        "prop-reply-phone",
        "Thanks",
        null,
        false,
        "+15550000002",
      );
    });
    expect(screen.getByLabelText("Reply to this lead")).toHaveValue("");
    expect(toast.success).toHaveBeenCalledWith("Message sent", {
      description: "Sent to +15550000002.",
    });
    expect(screen.getByRole("button", { name: "Insert template" })).toHaveClass(
      "min-h-11",
    );
  });

  it("does not claim success or clear the draft if immediate send unexpectedly queues", async () => {
    const user = userEvent.setup();
    vi.mocked(sendSmsFromLead).mockResolvedValueOnce({
      ok: true,
      data: { outcome: { status: "queued", messageId: "unexpected-queue" } },
    } as Awaited<ReturnType<typeof sendSmsFromLead>>);
    render(
      <InboxDetail
        data={makeData({ contactId: "contact-invalid-immediate-send" })}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    const composer = screen.getByLabelText("Reply to this lead");
    await user.type(composer, "keep this draft");
    await user.click(screen.getByTestId("inline-reply-send"));

    await waitFor(() => expect(sendSmsFromLead).toHaveBeenCalledOnce());
    expect(composer).toHaveValue("keep this draft");
    expect(toast.error).toHaveBeenCalledWith("Send did not complete", {
      description:
        "The server queued this reply unexpectedly. Review Outbox before retrying.",
    });
  });

  it("explains a missing approved sender and preserves the reply draft", async () => {
    const user = userEvent.setup();
    vi.mocked(sendSmsFromLead).mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: {
          status: "blocked_no_approved_sender",
          reason: "No approved sender is available for this conversation.",
        },
      },
    });
    render(
      <InboxDetail
        data={makeData({ contactId: "contact-no-approved-sender" })}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    const composer = screen.getByLabelText("Reply to this lead");
    await user.type(composer, "keep this draft too");
    await user.click(screen.getByTestId("inline-reply-send"));

    await waitFor(() => expect(sendSmsFromLead).toHaveBeenCalledOnce());
    expect(toast.error).toHaveBeenCalledWith("No approved sender", {
      description: "No approved sender is available for this conversation.",
    });
    expect(composer).toHaveValue("keep this draft too");
  });

  it("renders a persisted queued reply after reload instead of dropping it from the thread", () => {
    render(
      <InboxDetail
        data={makeData({
          contactId: "contact-persisted-queued",
          propertyId: "prop-persisted-queued",
          initialMessages: [
            makeMessage({
              id: "queued-after-reload",
              contact_id: "contact-persisted-queued",
              property_id: "prop-persisted-queued",
              conversation_id: "conv-contact-persisted-queued",
              direction: "outbound",
              status: "queued",
              body: "durable queued body",
            }),
          ],
        })}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    expect(screen.getByText("durable queued body")).toBeInTheDocument();
    expect(
      screen.getByTestId("messages-thread-delivery-status"),
    ).toHaveTextContent("Queued · in Outbox");
  });

  it("pauses Messages replies after a live same-thread insert until server detail refreshes", async () => {
    const data = makeData({
      contactId: "contact-live-refresh",
      propertyId: "prop-live-refresh",
      threadId: "conv-live-refresh",
      conversationId: "conv-live-refresh",
      threadCustomerPhone: "+15550000001",
      contactPhone: "+15550000001",
      replyToPhone: "+15550000001",
      initialMessages: [
        makeMessage({
          id: "initial-live-refresh",
          body: "old phone",
          direction: "inbound",
          contact_id: "contact-live-refresh",
          property_id: "prop-live-refresh",
          conversation_id: "conv-live-refresh",
          from_address: "+15550000001",
        }),
      ],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    await waitFor(() => {
      expect(supabaseMock.subscriptions.length).toBeGreaterThan(0);
    });
    const insertSubscription = supabaseMock.subscriptions.find(
      (subscription) =>
        subscription.type === "postgres_changes" &&
        subscription.filter.event === "INSERT",
    );
    expect(insertSubscription).toBeDefined();

    await act(async () => {
      insertSubscription!.callback({
        new: makeMessage({
          id: "new-live-refresh",
          body: "new phone",
          direction: "inbound",
          contact_id: "contact-live-refresh",
          property_id: "prop-live-refresh",
          conversation_id: "conv-live-refresh",
          from_address: "+15550000002",
          created_at: "2026-04-29T12:01:00Z",
        }),
      });
    });

    expect(screen.getByTestId("inline-reply-refreshing")).toHaveTextContent(
      "Updating the thread phone before reply",
    );
    expect(screen.queryByTestId("inline-reply")).not.toBeInTheDocument();
    expect(refreshCalls.length).toBeGreaterThan(0);
  });

  it("does not render the homeowner reply composer for agent-only threads", () => {
    const data = makeData({
      contactId: "agent-contact",
      homeownerContactId: "homeowner-contact",
      agentContactId: "agent-contact",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.queryByTestId("inline-reply")).not.toBeInTheDocument();
    expect(screen.getByTestId("inline-reply-unavailable")).toHaveTextContent(
      "thread contact is the homeowner",
    );
    expectSharedOutcomeControls({ moveToLeadDisabled: false });
  });

  it("renders message outcomes without the old Nurture scheduling popover", () => {
    const data = makeData({
      contactId: "contact-outcomes",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expectSharedOutcomeControls({ moveToLeadDisabled: false });
    expect(screen.queryByTestId("dispo-nurture")).not.toBeInTheDocument();
    expect(screen.queryByText("Follow up on")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assignee-select")).not.toBeInTheDocument();
  });

  it("sets the needs_sequence live label from the picker", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-needs-sequence",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    await user.click(screen.getByTestId("dispo-needs-sequence"));

    expect(setOutreachDispoMock).toHaveBeenCalledWith(
      "prop-1",
      "needs_sequence",
    );
    await waitFor(() => {
      expect(screen.getAllByText("Needs sequence")).toHaveLength(2);
    });
  });

  it("sets nurture (Follow up) from the picker button", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-follow-up-click",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    await user.click(screen.getByTestId("dispo-follow-up"));

    expect(setOutreachDispoMock).toHaveBeenCalledWith("prop-1", "nurture");
  });

  it("renders legacy nurture values as Follow up without changing the value", () => {
    const data = makeData({
      contactId: "contact-follow-up",
      outreachDispo: "nurture",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    // "Follow up" now appears twice when nurture is the active dispo: the
    // picker button and the active-disposition label.
    expect(screen.getAllByText("Follow up")).toHaveLength(2);
    expect(screen.queryByText("Legacy follow-up")).not.toBeInTheDocument();
    expect(screen.queryByText("Nurture")).not.toBeInTheDocument();
  });

  it("keeps lead promotion out of the More outcome menu", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-more-menu",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    await user.click(screen.getByTestId("dispo-more"));

    expect(await screen.findByTestId("dispo-bad-number")).toBeInTheDocument();
    expect(screen.getByTestId("dispo-opted-out")).toBeInTheDocument();
    expect(
      screen.queryByTestId("dispo-open-lead-task"),
    ).not.toBeInTheDocument();
  });

  it("message outcomes call setOutreachDispo without task scheduling fields", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-dispo-click",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    await user.click(screen.getByTestId("dispo-not-interested"));

    expect(setOutreachDispoMock).toHaveBeenCalledWith(
      "prop-1",
      "not_interested",
    );
  });

  it("defers permanent DNC to the confirmed compliance workflow instead of exposing a one-click Messages action", () => {
    const data = makeData({
      contactId: "contact-permanent-dnc",
      propertyId: "prop-permanent-dnc",
      propertyStatus: "new_lead",
      isDncLocked: false,
      contactDoNotContact: false,
      contactSmsOptedOut: false,
      outreachDispo: null,
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.getByTestId("assign-dropdown-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("inline-reply")).toBeInTheDocument();
    const deferred = screen.getByTestId("dispo-dnc-deferred");
    expect(deferred).toBeDisabled();
    expect(deferred).toHaveAttribute(
      "title",
      "Permanent DNC requires the deferred confirmed compliance workflow.",
    );
    expect(screen.queryByTestId("dispo-dnc")).toBeNull();
    expect(setOutreachDispoMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("assign-dropdown-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("inline-reply")).toBeInTheDocument();
  });

  it("Move to Lead promotes then opens the lead page", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-move-lead",
      propertyId: "prop-move",
      propertyStatus: "prospect",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    await user.click(screen.getByTestId("message-move-to-lead"));

    expect(moveMessageThreadToLeadMock).toHaveBeenCalledWith("prop-move");
    expect(pushCalls).toContain("/leads/prop-move");
  });

  it("header Open prospect navigates without promoting", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-header-move",
      propertyId: "prop-header-move",
      propertyStatus: "prospect",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    await user.click(screen.getByTestId("inbox-detail-open-lead"));

    expect(screen.getByTestId("inbox-detail-open-lead")).toHaveTextContent(
      "Open prospect",
    );
    expect(moveMessageThreadToLeadMock).not.toHaveBeenCalled();
    expect(pushCalls).toContain("/leads/prop-header-move");
  });

  it("already-qualified rows open as leads while keeping outcome promotion disabled", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-open-lead",
      propertyId: "prop-open",
      propertyStatus: "new_lead",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    const moveToLead = screen.getByTestId("message-move-to-lead");
    expectSharedOutcomeControls({ moveToLeadDisabled: true });
    expect(screen.getByTestId("inbox-detail-open-lead")).toHaveTextContent(
      "Open lead",
    );
    expect(screen.getByTestId("inbox-detail-open-lead")).toBeEnabled();

    await user.click(moveToLead);

    expect(moveMessageThreadToLeadMock).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("inbox-detail-open-lead"));
    expect(pushCalls).toContain("/leads/prop-open");
  });

  it("disables Move to Lead when the same property refreshes from prospect to lead", () => {
    const prospectData = makeData({
      contactId: "contact-status-refresh",
      propertyId: "prop-status-refresh",
      propertyStatus: "prospect",
      initialMessages: [],
    });
    const leadData = {
      ...prospectData,
      propertyStatus: "new_lead",
    };

    const { rerender } = render(
      <InboxDetail
        data={prospectData}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    expectSharedOutcomeControls({ moveToLeadDisabled: false });
    expect(screen.getByTestId("inbox-detail-open-lead")).toBeEnabled();

    rerender(
      <InboxDetail
        data={leadData}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    expectSharedOutcomeControls({ moveToLeadDisabled: true });
    expect(screen.getByTestId("inbox-detail-open-lead")).toBeEnabled();
  });

  it("copies record, conversation, and active thread phone from the More menu", async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    const data = makeData({
      contactId: "contact-copy",
      propertyId: "prop-copy",
      threadId: "conv-copy",
      conversationId: "conv-copy",
      propertyStatus: "prospect",
      threadCustomerPhone: "+15550000002",
      threadBusinessPhone: "+18162804181",
      contactPhone: "+15550000002",
      replyToPhone: "+15550000002",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    await user.click(screen.getByTestId("inbox-detail-more"));
    await user.click(await screen.findByTestId("copy-record-link"));
    await user.click(screen.getByTestId("inbox-detail-more"));
    await user.click(await screen.findByTestId("copy-conversation-link"));
    await user.click(screen.getByTestId("inbox-detail-more"));
    await user.click(await screen.findByTestId("copy-phone-number"));

    await user.click(screen.getByTestId("inbox-detail-more"));
    expect(await screen.findByTestId("inbox-detail-phone")).toHaveTextContent(
      "Call +1 (555) 000-0002",
    );

    expect(clipboard).toHaveBeenCalledWith(
      `${window.location.origin}/leads/prop-copy`,
    );
    expect(clipboard).toHaveBeenCalledWith(
      `${window.location.origin}/messages?thread=conv-copy`,
    );
    expect(clipboard).toHaveBeenCalledWith("+15550000002");
  });

  it("contact-only threads expose resolve and omit record actions", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-only",
      propertyId: null,
      propertyAddress: null,
      homeownerContactId: null,
      propertyStatus: null,
      threadCustomerPhone: "+15550000003",
      contactPhone: "+15550000003",
      replyToPhone: "+15550000003",
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(
      screen.queryByTestId("inbox-detail-open-lead"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("resolve-to-property-open")).toBeInTheDocument();

    await user.click(screen.getByTestId("inbox-detail-more"));

    expect(screen.queryByTestId("copy-record-link")).not.toBeInTheDocument();
    expect(
      await screen.findByTestId("copy-conversation-link"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("copy-phone-number")).toBeInTheDocument();
  });

  it("does not reply from Messages when the visible thread phone is not saved on the contact", () => {
    const data = makeData({
      contactId: "contact-unsaved-thread-phone",
      propertyId: "prop-unsaved-thread-phone",
      homeownerContactId: "contact-unsaved-thread-phone",
      threadCustomerPhone: "+15550000004",
      contactPhone: "+15550000004",
      replyToPhone: null,
      initialMessages: [],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.queryByTestId("inline-reply")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /This thread number is not saved on the homeowner contact/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders a permanent-DNC thread as read-only history with unsafe controls removed", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-locked",
      propertyId: "prop-locked",
      propertyStatus: "new_lead",
      isDncLocked: true,
      contactDoNotContact: true,
      contactSmsOptedOut: true,
      initialMessages: [
        makeMessage({
          id: "locked-history",
          body: "historical reply",
          direction: "inbound",
          contact_id: "contact-locked",
          property_id: "prop-locked",
          conversation_id: "conv-contact-locked",
        }),
      ],
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.getByTestId("messages-permanent-dnc-lock")).toHaveTextContent(
      "PERMANENT DO NOT CONTACT",
    );
    expect(screen.getByTestId("message-stage-chip")).toHaveTextContent(
      "Historical · New Lead",
    );
    expect(screen.getByText("historical reply")).toBeInTheDocument();
    expect(
      screen.queryByTestId("assign-dropdown-trigger"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("dispo-wrong-number")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inline-reply")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("inline-reply-restricted"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("inbox-detail-more"));
    expect(screen.queryByTestId("inbox-detail-phone")).not.toBeInTheDocument();
    expect(
      await screen.findByTestId("copy-conversation-link"),
    ).toBeInTheDocument();
  });

  it("shows SMS opt-out as channel-specific and keeps non-SMS outcomes available", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-sms-optout",
      contactSmsOptedOut: true,
      outreachDispo: "opted_out",
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(
      screen.getByTestId("messages-contact-restriction"),
    ).toHaveTextContent("SMS disabled");
    expect(
      screen.getByTestId("messages-contact-restriction"),
    ).toHaveTextContent("not the permanent organization-wide DNC lock");
    expect(screen.getByTestId("inline-reply-restricted")).toBeInTheDocument();
    expect(screen.getByTestId("dispo-follow-up")).toBeInTheDocument();
    expect(screen.getByTestId("dispo-dnc-deferred")).not.toHaveClass(
      "bg-red-50",
    );
    expect(
      screen.queryByTestId("messages-permanent-dnc-lock"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("inbox-detail-more"));
    expect(await screen.findByTestId("inbox-detail-phone")).toBeInTheDocument();
  });

  it("uses canonical consent and phone suppression for SMS without inventing a voice DNC", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-canonical-optout",
      smsConsentState: "opted_out",
      phoneSuppressed: true,
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.queryByTestId("inline-reply")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("messages-contact-restriction"),
    ).toHaveTextContent("canonical consent or phone suppression");
    await user.click(screen.getByTestId("inbox-detail-more"));
    expect(await screen.findByTestId("inbox-detail-phone")).toBeInTheDocument();
  });

  it("fails closed when authoritative SMS safety reads fail", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-safety-read-failed",
      smsConsentState: null,
      phoneSuppressed: null,
      smsSafetyReadFailed: true,
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(screen.queryByTestId("inline-reply")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("messages-contact-restriction"),
    ).toHaveTextContent("could not be verified");
    await user.click(screen.getByTestId("inbox-detail-more"));
    expect(screen.queryByTestId("inbox-detail-phone")).not.toBeInTheDocument();
  });

  it("removes outreach outcomes and channel controls for a suppressed contact", async () => {
    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-suppressed",
      contactDoNotContact: true,
    });

    render(
      <InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />,
    );

    expect(
      screen.getByTestId("messages-contact-restriction"),
    ).toHaveTextContent("outreach is blocked for this contact");
    expect(screen.queryByTestId("dispo-follow-up")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inline-reply")).not.toBeInTheDocument();
    expect(screen.getByTestId("inline-reply-restricted")).toBeInTheDocument();

    await user.click(screen.getByTestId("inbox-detail-more"));
    expect(screen.queryByTestId("inbox-detail-phone")).not.toBeInTheDocument();
  });
});
