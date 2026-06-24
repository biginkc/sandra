import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(() => {
    const channel = {
      on: vi.fn(() => channel),
      subscribe: vi.fn(() => channel),
    };
    return {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      },
      realtime: { setAuth: vi.fn() },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    };
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient,
}));

import { MessagesThread, messageBelongsToThread } from "./messages-thread";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

function makeMessage(
  overrides: Partial<MessageRow> & { id: string },
): MessageRow {
  return {
    id: overrides.id,
    channel: "sms",
    direction: overrides.direction ?? "inbound",
    status: overrides.status ?? "received",
    contact_id: overrides.contact_id ?? "contact-1",
    property_id: overrides.property_id ?? "property-1",
    conversation_id: overrides.conversation_id ?? null,
    body: overrides.body ?? "hello",
    from_address: overrides.from_address ?? "+15551234567",
    to_address: overrides.to_address ?? "+18165550000",
    created_at: overrides.created_at ?? "2026-06-09T12:00:00.000Z",
    read_at: overrides.read_at ?? null,
    metadata: overrides.metadata ?? null,
  } as MessageRow;
}

describe("messageBelongsToThread", () => {
  it("uses conversation id as the only match key when the thread has one", () => {
    const activeConversation = "11111111-1111-4111-8111-111111111111";
    const siblingConversation = "22222222-2222-4222-8222-222222222222";

    const matching = makeMessage({
      id: "m1",
      contact_id: "contact-1",
      property_id: "property-1",
      conversation_id: activeConversation,
    });
    const sibling = makeMessage({
      id: "m2",
      contact_id: "contact-1",
      property_id: "property-1",
      conversation_id: siblingConversation,
    });

    expect(
      messageBelongsToThread(matching, {
        contactId: "contact-1",
        propertyId: "property-1",
        conversationId: activeConversation,
      }),
    ).toBe(true);
    expect(
      messageBelongsToThread(sibling, {
        contactId: "contact-1",
        propertyId: "property-1",
        conversationId: activeConversation,
      }),
    ).toBe(false);
  });

  it("falls back to property/contact matching for legacy threads without a conversation id", () => {
    const legacyRow = makeMessage({
      id: "m3",
      contact_id: "contact-9",
      property_id: "property-9",
      conversation_id: null,
    });

    expect(
      messageBelongsToThread(legacyRow, {
        contactId: "contact-9",
        propertyId: "property-9",
        conversationId: null,
      }),
    ).toBe(true);
  });

  it("does not leak same-contact messages from a sibling property into a legacy thread", () => {
    const siblingPropertyRow = makeMessage({
      id: "m4",
      contact_id: "contact-9",
      property_id: "property-10",
      conversation_id: null,
    });

    expect(
      messageBelongsToThread(siblingPropertyRow, {
        contactId: "contact-9",
        propertyId: "property-9",
        conversationId: null,
      }),
    ).toBe(false);
  });
});

describe("<MessagesThread />", () => {
  it("filters sibling-thread rows out of the initial render", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "matching",
            contact_id: "contact-9",
            property_id: "property-9",
            body: "right thread",
          }),
          makeMessage({
            id: "sibling",
            contact_id: "contact-9",
            property_id: "property-10",
            body: "wrong thread",
          }),
        ]}
        contactId="contact-9"
        propertyId="property-9"
      />,
    );

    expect(screen.getByText("right thread")).toBeInTheDocument();
    expect(screen.queryByText("wrong thread")).not.toBeInTheDocument();
  });

  it.each([
    ["queued", "Pending"],
    ["pending", "Pending"],
    ["sent", "Sent"],
    ["delivered", "Delivered"],
  ])(
    "renders %s under the most recent outbound message only",
    (status, expectedLabel) => {
      render(
        <MessagesThread
          initial={[
            makeMessage({
              id: "older-outbound",
              direction: "outbound",
              status: "sent",
              body: "older outbound",
              created_at: "2026-06-09T12:00:00.000Z",
            }),
            makeMessage({
              id: "mid-inbound",
              direction: "inbound",
              body: "mid inbound",
              created_at: "2026-06-09T12:02:00.000Z",
            }),
            makeMessage({
              id: "newest-outbound",
              direction: "outbound",
              status,
              body: "newest outbound",
              created_at: "2026-06-09T12:05:00.000Z",
            }),
          ]}
          contactId="contact-1"
          propertyId="property-1"
        />,
      );

      const labels = screen.getAllByTestId("messages-thread-delivery-status");
      const threadMessages = screen.getAllByTestId("messages-thread-msg");
      expect(labels).toHaveLength(1);
      expect(labels[0]).toHaveTextContent(expectedLabel);
      expect(threadMessages[0]).not.toHaveTextContent(expectedLabel);
      expect(threadMessages[1]).not.toHaveTextContent(expectedLabel);
      expect(threadMessages[2]).toHaveTextContent(expectedLabel);
    },
  );

  it("renders red 'Not delivered' under any failed outbound message", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "failed-outbound",
            direction: "outbound",
            status: "failed",
            body: "failed outbound",
            created_at: "2026-06-09T12:00:00.000Z",
          }),
          makeMessage({
            id: "newer-inbound",
            direction: "inbound",
            body: "reply",
            created_at: "2026-06-09T12:05:00.000Z",
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    const label = screen.getByText("Not delivered");
    expect(label).toHaveClass("text-destructive");
  });

  it("keeps 'Not delivered' on a failed outbound continuation bubble", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "failed-outbound",
            direction: "outbound",
            status: "failed",
            body: "failed outbound",
            created_at: "2026-06-09T12:00:00.000Z",
          }),
          makeMessage({
            id: "later-outbound",
            direction: "outbound",
            status: "sent",
            body: "later outbound",
            created_at: "2026-06-09T12:05:00.000Z",
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    const threadMessages = screen.getAllByTestId("messages-thread-msg");
    expect(threadMessages[0]).toHaveTextContent("Not delivered");
    expect(threadMessages[1]).toHaveTextContent("Sent");
  });

  it("keeps the inline badge for uncommon outbound statuses", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "custom-status",
            direction: "outbound",
            status: "provider_failed",
            body: "custom status outbound",
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    expect(screen.getByText("provider_failed")).toBeInTheDocument();
    expect(
      screen.queryByTestId("messages-thread-delivery-status"),
    ).not.toBeInTheDocument();
  });

  it("does not render a delivery label for inbound messages", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "inbound-only",
            direction: "inbound",
            body: "hello from inbound",
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    expect(
      screen.queryByTestId("messages-thread-delivery-status"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
    expect(screen.queryByText("Not delivered")).not.toBeInTheDocument();
  });

  it("marks AI-generated outbound replies with the Sandra face icon", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "sandra-reply",
            direction: "outbound",
            status: "delivered",
            body: "No repairs needed.",
            metadata: {
              generated_by: "ai_responder_v1",
              confidence: 0.92,
            },
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    const icon = screen.getByTestId("messages-thread-sandra-reply-icon");
    expect(
      screen.getByRole("img", { name: "Sandra replied" }),
    ).toBeInTheDocument();
    expect(icon).toHaveAccessibleName("Sandra replied");
    expect(icon).toHaveAttribute(
      "title",
      "Sandra replied · confidence 92%",
    );
    expect(screen.queryByText("AI")).not.toBeInTheDocument();
  });

  it("does not mark manual outbound replies as Sandra replies", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "manual-reply",
            direction: "outbound",
            status: "delivered",
            body: "Manual reply",
            metadata: null,
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    expect(
      screen.queryByTestId("messages-thread-sandra-reply-icon"),
    ).not.toBeInTheDocument();
  });

  it("marks an AI-generated reply even when a manual outbound follows it", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "sandra-reply",
            direction: "outbound",
            status: "delivered",
            body: "Sandra reply",
            created_at: "2026-06-09T12:00:00.000Z",
            metadata: {
              generated_by: "ai_responder_v1",
              confidence: 0.87,
            },
          }),
          makeMessage({
            id: "manual-followup",
            direction: "outbound",
            status: "sent",
            body: "Manual follow-up",
            created_at: "2026-06-09T12:03:00.000Z",
            metadata: null,
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    const threadMessages = screen.getAllByTestId("messages-thread-msg");
    expect(threadMessages[0]).toContainElement(
      screen.getByTestId("messages-thread-sandra-reply-icon"),
    );
    expect(threadMessages[1]).not.toContainElement(
      screen.getByTestId("messages-thread-sandra-reply-icon"),
    );
  });

  it("marks each AI-generated reply in a consecutive outbound burst", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "first-sandra-reply",
            direction: "outbound",
            status: "delivered",
            body: "First Sandra reply",
            created_at: "2026-06-09T12:00:00.000Z",
            metadata: {
              generated_by: "ai_responder_v1",
              confidence: 0.87,
            },
          }),
          makeMessage({
            id: "second-sandra-reply",
            direction: "outbound",
            status: "sent",
            body: "Second Sandra reply",
            created_at: "2026-06-09T12:03:00.000Z",
            metadata: {
              generated_by: "ai_responder_v1",
              confidence: 0.91,
            },
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    expect(screen.getAllByTestId("messages-thread-sandra-reply-icon")).toHaveLength(
      2,
    );
  });
});
