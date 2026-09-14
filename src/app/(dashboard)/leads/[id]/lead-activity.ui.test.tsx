import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CallActivityRollupRow } from "./lead-call-summary";
import type { LeadEvent } from "./lead-events";
import type { Message } from "./messages-thread";
import type { Note } from "./notes-feed";

const leadEventHookState = vi.hoisted(() => ({ reconciled: true }));

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
    expect(bubbles[1]).toHaveTextContent("Existing SMS bubble stays intact");
    expect(screen.getAllByTestId("messages-thread-metadata")).toHaveLength(1);
    expect(
      screen.getByTestId("messages-thread-delivery-status"),
    ).toHaveTextContent("Queued · in Outbox");
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
          created_at: "2026-08-25T18:00:00.000Z",
          started_at: "2026-08-25T18:00:00.000Z",
          outcome: "completed",
          disposition: null,
          recording_status: "none",
          transcript_status: "none",
          summary_status: "none",
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
