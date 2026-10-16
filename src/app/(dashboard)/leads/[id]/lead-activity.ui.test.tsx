import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CallActivityRollupRow } from "./lead-call-summary";
import type { LeadEvent } from "./lead-events";
import type { Message } from "./messages-thread";
import type { Note } from "./notes-feed";

const leadEventHookState = vi.hoisted(() => ({ reconciled: true }));
const { messageDripLabels } = vi.hoisted(() => ({ messageDripLabels: vi.fn().mockResolvedValue({}) }));

vi.mock("@/lib/sequences/message-drip-labels", () => ({ messageDripLabels }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

vi.mock("./messages-thread", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./messages-thread")>();
  return {
    ...actual,
    useLeadMessages: ({ initial }: { initial: Message[] }) => initial,
  };
});

vi.mock("./notes-feed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notes-feed")>();
  return {
    ...actual,
    useLeadNotes: ({
      initial,
      authorEmails,
    }: {
      initial: Note[];
      authorEmails: Record<string, string>;
    }) => ({ notes: initial, authorEmails }),
  };
});

vi.mock("./lead-call-summary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lead-call-summary")>();
  return {
    ...actual,
    useLeadCallRows: ({
      initialRows,
    }: {
      initialRows: CallActivityRollupRow[];
    }) => initialRows,
  };
});

vi.mock("./lead-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lead-events")>();
  return {
    ...actual,
    useLeadEvents: ({ initial }: { initial: LeadEvent[] }) => ({
      events: initial,
      reconciled: leadEventHookState.reconciled,
    }),
  };
});

import { LeadActivityTimeline } from "./lead-activity";

beforeEach(() => {
  leadEventHookState.reconciled = true;
  messageDripLabels.mockReset();
  messageDripLabels.mockResolvedValue({});
});

function message({
  id,
  body,
  createdAt,
  status,
}: {
  id: string;
  body: string;
  createdAt: string;
  status: string;
}): Message {
  return {
    id,
    channel: "sms",
    direction: "outbound",
    status,
    contact_id: "contact-1",
    property_id: "property-1",
    conversation_id: null,
    body,
    from_address: "+18165550000",
    to_address: "+15551234567",
    created_at: createdAt,
    read_at: null,
    metadata: null,
  } as Message;
}

function event(id: string, createdAt: string): LeadEvent {
  return {
    id,
    property_id: "property-1",
    actor_type: "system",
    actor_id: null,
    event_type: "qualified",
    payload: { from: "prospect", to: "new_lead" },
    created_at: createdAt,
  };
}

describe("<LeadActivityTimeline /> with lead events", () => {
  it("labels a live outbound message after its step-run association arrives on a status update", async () => {
    const props = {
      propertyId: "property-1", contactId: "contact-1", initialNotes: [], initialCalls: [], initialEvents: [],
      messageError: null, noteError: null, callError: null, eventError: null,
      authorEmails: {}, currentUserId: null, currentUserEmail: null, jitterHost: "",
    };
    messageDripLabels.mockResolvedValueOnce({}).mockResolvedValueOnce({ "message-1": "Drip · Follow up · text 1 of 4" });
    const view = render(<LeadActivityTimeline {...props} initialMessages={[message({ id: "message-1", body: "Hello", createdAt: "2026-09-29T14:00:00Z", status: "queued" })]} />);
    await waitFor(() => expect(messageDripLabels).toHaveBeenCalledTimes(1));
    view.rerender(<LeadActivityTimeline {...props} initialMessages={[message({ id: "message-1", body: "Hello", createdAt: "2026-09-29T14:00:00Z", status: "sent" })]} />);
    expect(await screen.findByText("Drip · Follow up · text 1 of 4")).toBeInTheDocument();
    expect(messageDripLabels).toHaveBeenCalledTimes(2);
  });

  it("stops reconciling an unlabeled outbound message after three timed retries", async () => {
    vi.useFakeTimers();
    try {
      const props = {
        propertyId: "property-1", contactId: "contact-1", initialNotes: [], initialCalls: [], initialEvents: [],
        messageError: null, noteError: null, callError: null, eventError: null,
        authorEmails: {}, currentUserId: null, currentUserEmail: null, jitterHost: "",
      };
      const view = render(<LeadActivityTimeline {...props} initialMessages={[message({ id: "message-1", body: "Hello", createdAt: "2026-09-29T14:00:00Z", status: "queued" })]} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(messageDripLabels).toHaveBeenCalledTimes(4);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(messageDripLabels).toHaveBeenCalledTimes(4);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not retry label lookup for an old sent outbound message", async () => {
    vi.useFakeTimers();
    try {
      const props = {
        propertyId: "property-1", contactId: "contact-1", initialNotes: [], initialCalls: [], initialEvents: [],
        messageError: null, noteError: null, callError: null, eventError: null,
        authorEmails: {}, currentUserId: null, currentUserEmail: null, jitterHost: "",
      };
      const view = render(<LeadActivityTimeline {...props} initialMessages={[message({ id: "old", body: "Hello", createdAt: "2025-01-01T14:00:00Z", status: "sent" })]} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
      expect(messageDripLabels).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it("interleaves compact events without changing the existing SMS bubble", () => {
    render(
      <LeadActivityTimeline
        propertyId="property-1"
        contactId="contact-1"
        initialMessages={[
          message({
            id: "message-1",
            body: "First existing SMS bubble",
            createdAt: "2026-08-25T16:30:00.000Z",
            status: "sent",
          }),
          message({
            id: "message-2",
            body: "Existing SMS bubble stays intact",
            createdAt: "2026-08-25T17:00:00.000Z",
            status: "queued",
          }),
        ]}
        initialNotes={[]}
        initialCalls={[]}
        initialEvents={[
          event("before", "2026-08-25T16:00:00.000Z"),
          event("after", "2026-08-25T18:00:00.000Z"),
        ]}
        messageError={null}
        noteError={null}
        callError={null}
        eventError={null}
        authorEmails={{}}
        currentUserId={null}
        currentUserEmail={null}
        jitterHost=""
      />,
    );

    const orderedRows = screen
      .getByTestId("lead-activity-timeline")
      .querySelectorAll(
        '[data-testid="lead-event-row"], [data-testid="messages-thread-msg"]',
      );
    expect(
      [...orderedRows].map((row) => row.getAttribute("data-testid")),
    ).toEqual([
      "lead-event-row",
      "messages-thread-msg",
      "messages-thread-msg",
      "lead-event-row",
    ]);
    const bubbles = screen.getAllByTestId("messages-thread-msg");
    expect(bubbles[0]).toHaveAttribute("data-presentation", "timeline");
    expect(bubbles[0]).toHaveAttribute("data-continuation", "false");
    expect(bubbles[1]).toHaveAttribute("data-continuation", "true");
    expect(bubbles[1]).toHaveTextContent("Outbound → Seller");
    expect(bubbles[0]).toHaveTextContent("Existing SMS bubble stays intact");
    expect(bubbles[1]).toHaveTextContent("First existing SMS bubble");
    expect(screen.getAllByTestId("messages-thread-metadata")).toHaveLength(2);
    expect(
      screen.getByTestId("messages-thread-delivery-status"),
    ).toHaveTextContent("Queued · in Outbox");
  });

  it("keeps the newest inbound STOP badge and each timestamp visible", () => {
    const older = { ...message({ id: "older", body: "Hello", createdAt: "2026-08-25T17:00:00Z", status: "received" }), direction: "inbound" as const };
    const newer = { ...older, id: "newer", body: "stop", created_at: "2026-08-25T18:00:00Z", metadata: { keyword: "stop" } };
    render(<LeadActivityTimeline propertyId="property-1" contactId={null} initialMessages={[older, newer]} initialNotes={[]} initialCalls={[]} initialEvents={[]} messageError={null} noteError={null} callError={null} eventError={null} authorEmails={{}} currentUserId={null} currentUserEmail={null} jitterHost="" />);
    const rows = screen.getAllByTestId("messages-thread-msg");
    expect(within(rows[0]).getByText("STOP", { exact: true })).toBeVisible();
    expect(within(rows[0]).getByTestId("messages-thread-metadata")).toBeVisible();
    expect(within(rows[1]).getByTestId("messages-thread-metadata")).toBeVisible();
  });

  it("keeps newly received activity first and older-history controls last", () => {
    const props = {
      propertyId: "property-1", contactId: null,
      initialMessages: [], initialNotes: [], initialCalls: [], initialEvents: [],
      messageError: null, noteError: null, callError: null, eventError: null,
      authorEmails: {}, currentUserId: null, currentUserEmail: null, jitterHost: "",
    };
    const first = message({ id: "first", body: "Earlier message", createdAt: "2026-08-25T17:00:00Z", status: "sent" });
    const latest = message({ id: "latest", body: "Newest message", createdAt: "2026-08-25T18:00:00Z", status: "sent" });
    const history = {
      ok: true as const,
      page: {
        rows: [{ kind: "offer" as const, id: "offer-old", at: "2026-08-25T16:00:00Z", actorId: null, amountCents: "10000", method: "verbal" as const, followUpAt: "2026-08-26T16:00:00Z", outcome: "pending" as const, outcomeAt: null }],
        hasMore: true, cursor: null,
      },
    };
    const view = render(<LeadActivityTimeline {...props} initialMessages={[first]} initialAcquisitionHistory={history} />);
    view.rerender(<LeadActivityTimeline {...props} initialMessages={[first, latest]} initialAcquisitionHistory={history} />);
    const bubbles = screen.getAllByTestId("messages-thread-msg");
    expect(bubbles[0]).toHaveTextContent("Newest message");
    expect(bubbles[1]).toHaveTextContent("Earlier message");
    const offer = screen.getByTestId("lead-acquisition-offer-offer-old");
    const boundary = screen.getByTestId("lead-activity-trust-floor");
    const more = screen.getByRole("button", { name: "Load older outreach and offers" });
    expect(offer.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(boundary.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("clears a stale server activity error after an empty live reconciliation", async () => {
    render(
      <LeadActivityTimeline
        propertyId="property-1"
        contactId="contact-1"
        initialMessages={[]}
        initialNotes={[]}
        initialCalls={[]}
        initialEvents={[]}
        messageError={null}
        noteError={null}
        callError={null}
        eventError="Initial activity read failed"
        authorEmails={{}}
        currentUserId={null}
        currentUserEmail={null}
        jitterHost=""
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("lead-event-source-failure"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("No messages, notes, calls, or activity yet."),
    ).toBeInTheDocument();
  });

  it("keeps recovered activity visible during a new same-lead failure", () => {
    const recovered = event("recovered", "2026-08-25T18:00:00.000Z");
    const props = {
      propertyId: "property-1",
      contactId: "contact-1",
      initialMessages: [],
      initialNotes: [],
      initialCalls: [],
      messageError: null,
      noteError: null,
      callError: null,
      authorEmails: {},
      currentUserId: null,
      currentUserEmail: null,
      jitterHost: "",
    };
    const { rerender } = render(
      <LeadActivityTimeline
        {...props}
        initialEvents={[recovered]}
        eventError={null}
      />,
    );
    expect(screen.getByTestId("lead-event-row")).toBeInTheDocument();

    leadEventHookState.reconciled = false;
    rerender(
      <LeadActivityTimeline
        {...props}
        initialEvents={[]}
        eventError="Refreshed activity read failed"
      />,
    );

    expect(screen.getByTestId("lead-event-row")).toBeInTheDocument();
    expect(screen.getByTestId("lead-event-source-failure")).toHaveTextContent(
      "Activity did not load",
    );
  });
});

it("retains reached, rep note, actor and recording time inside one linked Sandra call", () => {
  const attempt = {
    kind: "attempt" as const,
    id: "linked-attempt",
    at: "2026-08-25T18:05:00.000Z",
    actorId: "original-rep",
    source: "sandra",
    attemptKind: "call",
    outcome: "reached",
    note: "Seller wants a Friday callback",
    recordingUrl: null,
    callActivityId: "physical-call",
  };
  render(
    <LeadActivityTimeline
      propertyId="property-1"
      contactId="contact-1"
      initialMessages={[]}
      initialNotes={[]}
      initialEvents={[]}
      initialCalls={[
        {
          id: "physical-call",
          provider_recording_url: "https://dialpad.com/recording.mp3",
          created_at: "2026-08-25T18:00:00.000Z",
          started_at: "2026-08-25T18:00:00.000Z",
          outcome: "completed",
          disposition: null,
          recording_status: "none",
          transcript_status: "none",
          summary_status: "none",
          provider: "sandra_softphone",
          jitter_attempt_id: "attempt-provider",
          jitter_session_id: "session-provider",
          call_recordings: [],
          call_transcripts: [],
        } as CallActivityRollupRow,
      ]}
      initialAcquisitionHistory={{
        ok: true,
        page: { rows: [attempt], hasMore: false, cursor: null },
      }}
      messageError={null}
      noteError={null}
      callError={null}
      eventError={null}
      authorEmails={{ "original-rep": "original@example.test" }}
      currentUserId="different-rep"
      currentUserEmail={null}
      jitterHost=""
    />,
  );
  expect(screen.getAllByTestId("lead-activity-call")).toHaveLength(1);
  const physicalCall = within(screen.getByTestId("lead-activity-call"));
  expect(physicalCall.getByText("Provider recording reference received. Playback is not available in Sandra.")).toBeVisible();
  expect(physicalCall.queryByText("No recording captured")).not.toBeInTheDocument();
  expect(physicalCall.getByText("Reached")).toBeInTheDocument();
  expect(
    physicalCall.getByText("Seller wants a Friday callback"),
  ).toBeInTheDocument();
  expect(physicalCall.getByText(/original@example.test/)).toBeInTheDocument();
  expect(
    physicalCall
      .getByTestId("lead-acquisition-attempt-linked-attempt")
      .querySelector("time"),
  ).toHaveAttribute("dateTime", attempt.at);
});


it.each(["", "https://jitter.example.test"])("chooses history actions per provider in a mixed timeline (host: %s)", (jitterHost) => {
  const calls = ["dialpad", "jitter", "sandra_softphone"].map((provider) => ({
    id: provider, provider, created_at: "2026-10-08T12:00:00Z", started_at: "2026-10-08T12:00:00Z",
    outcome: "connected_human", disposition: null, recording_status: "none", transcript_status: "none", summary_status: "none",
    jitter_attempt_id: provider, jitter_session_id: null, call_recordings: [], call_transcripts: [],
  } as CallActivityRollupRow));
  render(<LeadActivityTimeline propertyId="property-123" contactId={null} messageError={null} noteError={null} callError={null} eventError={null} initialMessages={[]} initialNotes={[]} initialEvents={[]} initialCalls={calls} authorEmails={{}} currentUserId={null} currentUserEmail={null} jitterHost={jitterHost} />);
  const cards = screen.getAllByTestId("lead-activity-call");
  expect(screen.queryByTitle("Jitter host not configured")).not.toBeInTheDocument();
  expect(screen.queryAllByRole("link", { name: "Open call in Jitter" })).toHaveLength(jitterHost ? 1 : 0);
  if (jitterHost) expect(screen.getByRole("link", { name: "Open call in Jitter" })).toHaveAttribute("href", "https://jitter.example.test/history?prospect_id=property-123");
  expect(cards).toHaveLength(3);
});
