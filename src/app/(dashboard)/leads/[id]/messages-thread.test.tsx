import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";

const { callbacks, createClient } = vi.hoisted(() => {
  const callbacks = {} as Partial<
    Record<"INSERT" | "UPDATE", (payload: { new: unknown }) => void>
  >;
  return {
    callbacks,
    createClient: vi.fn(() => {
      const channel = {
        on: vi.fn(
          (
            _kind: string,
            config: { event: "INSERT" | "UPDATE" },
            callback: (payload: { new: unknown }) => void,
          ) => {
            callbacks[config.event] = callback;
            return channel;
          },
        ),
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
  };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient,
}));

import {
  MessageBubble,
  MessagesThread,
  messageBelongsToThread,
  useLeadMessages,
} from "./messages-thread";

beforeEach(() => {
  delete callbacks.INSERT;
  delete callbacks.UPDATE;
  createClient.mockClear();
});

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

function makeMessage(
  overrides: Partial<MessageRow> & { id: string },
): MessageRow {
  return {
    id: overrides.id,
    channel: "sms",
    direction: overrides.direction ?? "inbound",
    status: overrides.status ?? "received",
    contact_id:
      overrides.contact_id !== undefined ? overrides.contact_id : "contact-1",
    property_id:
      overrides.property_id !== undefined
        ? overrides.property_id
        : "property-1",
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

  it("keeps property-linked and unassigned homeowner messages in lead mode", () => {
    const scope = {
      contactId: "contact-9",
      propertyId: "property-9",
      conversationId: null,
      matchMode: "lead" as const,
    };
    expect(
      messageBelongsToThread(
        makeMessage({
          id: "property-only",
          contact_id: null,
          property_id: "property-9",
        }),
        scope,
      ),
    ).toBe(true);
    expect(
      messageBelongsToThread(
        makeMessage({
          id: "contact-before-linkage",
          contact_id: "contact-9",
          property_id: null,
        }),
        scope,
      ),
    ).toBe(true);
    expect(
      messageBelongsToThread(
        makeMessage({
          id: "sibling-property",
          contact_id: "contact-9",
          property_id: "property-10",
        }),
        scope,
      ),
    ).toBe(false);
  });
});

describe("<MessageBubble presentation=timeline />", () => {
  it.each([
    ["queued", "Queued · in Outbox"],
    ["failed", "Not delivered"],
  ])("keeps %s delivery state visible", (status, label) => {
    render(
      <MessageBubble
        message={makeMessage({
          id: `timeline-${status}`,
          direction: "outbound",
          status,
        })}
        isContinuation={false}
        isLastInGroup
        isMostRecentOutbound
        presentation="timeline"
      />,
    );

    expect(screen.getByTestId("messages-thread-msg")).toHaveAttribute(
      "data-presentation",
      "timeline",
    );
    expect(
      screen.getByTestId("messages-thread-delivery-status"),
    ).toHaveTextContent(label);
    expect(screen.getByText("Outbound → Seller")).toBeVisible();
    expect(screen.queryByText("You → Seller")).not.toBeInTheDocument();
  });

  it("keeps Sandra provenance and identifies the automated sender", () => {
    render(
      <MessageBubble
        message={makeMessage({
          id: "timeline-sandra",
          direction: "outbound",
          status: "delivered",
          metadata: {
            generated_by: "ai_responder_v1",
            confidence: 0.92,
          },
        })}
        isContinuation={false}
        isLastInGroup
        isMostRecentOutbound
        presentation="timeline"
      />,
    );

    expect(screen.getByText("Sandra → Seller")).toBeVisible();
    expect(
      screen.getByTestId("messages-thread-sandra-reply-icon"),
    ).toHaveAttribute("title", "Sandra replied · confidence 92%");
    expect(screen.getByText("Delivered")).toBeVisible();
  });

  it("keeps inbound compliance keywords visible", () => {
    render(
      <MessageBubble
        message={makeMessage({
          id: "timeline-stop",
          direction: "inbound",
          body: "stop",
          metadata: { keyword: "stop" },
        })}
        isContinuation={false}
        isLastInGroup
        isMostRecentOutbound={false}
        presentation="timeline"
      />,
    );

    expect(screen.getByText("STOP")).toBeVisible();
  });
});

describe("useLeadMessages", () => {
  it("applies realtime inserts and updates to the bounded lead window", async () => {
    const initial = Array.from({ length: 200 }, (_, index) =>
      makeMessage({
        id: `message-${index}`,
        contact_id: null,
        property_id: "property-1",
        created_at: `2026-06-09T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      }),
    );
    const { result } = renderHook(() =>
      useLeadMessages({
        initial,
        scope: {
          contactId: "contact-1",
          conversationId: null,
          matchMode: "lead",
          propertyId: "property-1",
        },
      }),
    );
    await waitFor(() => expect(callbacks.INSERT).toBeDefined());

    const inserted = makeMessage({
      id: "message-new",
      contact_id: null,
      property_id: "property-1",
      created_at: "2026-06-09T16:00:00.000Z",
      body: "new realtime message",
    });
    act(() => callbacks.INSERT!({ new: inserted }));
    expect(result.current).toHaveLength(200);
    expect(result.current.at(-1)?.id).toBe("message-new");
    expect(result.current.some((row) => row.id === "message-0")).toBe(false);

    act(() =>
      callbacks.UPDATE!({
        new: { ...inserted, read_at: "2026-06-09T16:01:00.000Z" },
      }),
    );
    expect(result.current.at(-1)?.read_at).toBe("2026-06-09T16:01:00.000Z");
    expect(result.current.filter((row) => row.id === inserted.id)).toHaveLength(
      1,
    );

    act(() =>
      callbacks.UPDATE!({
        new: { ...inserted, property_id: "property-2" },
      }),
    );
    expect(result.current.some((row) => row.id === inserted.id)).toBe(false);
  });

  it("keeps one realtime subscription while using the latest live-message callback", async () => {
    const firstCallback = vi.fn();
    const latestCallback = vi.fn();
    const initial: MessageRow[] = [];
    const scope = {
      contactId: "contact-stable-subscription",
      conversationId: null,
      matchMode: "lead" as const,
      propertyId: "property-stable-subscription",
    };
    const { rerender } = renderHook(
      ({ onLiveMessage }) =>
        useLeadMessages({ initial, scope, onLiveMessage }),
      { initialProps: { onLiveMessage: firstCallback } },
    );

    await waitFor(() => expect(callbacks.INSERT).toBeDefined());
    const client = createClient.mock.results[0]?.value;
    const channel = client.channel.mock.results[0]?.value;
    expect(channel.on).toHaveBeenCalledTimes(2);

    rerender({ onLiveMessage: latestCallback });
    await act(async () => Promise.resolve());

    expect(client.removeChannel).not.toHaveBeenCalled();
    expect(channel.on).toHaveBeenCalledTimes(2);

    const inserted = makeMessage({
      id: "stable-subscription-insert",
      contact_id: null,
      property_id: scope.propertyId,
    });
    act(() => callbacks.INSERT!({ new: inserted }));

    expect(firstCallback).not.toHaveBeenCalled();
    expect(latestCallback).toHaveBeenCalledWith(inserted, "INSERT");
  });
});

describe("<MessagesThread />", () => {
  it("uses neutral empty copy that remains truthful when SMS is restricted", () => {
    render(
      <MessagesThread
        initial={[]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    expect(
      screen.getByText("No messages in this conversation yet."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/send an sms/i)).not.toBeInTheDocument();
  });

  it("advances a serialized day label across operator midnight without navigation", async () => {
    vi.useFakeTimers();
    const beforeChicagoMidnight = new Date("2026-06-10T04:59:30.000Z");
    vi.setSystemTime(beforeChicagoMidnight);
    const view = render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "midnight-message",
            created_at: "2026-06-10T04:00:00.000Z",
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
        nowMs={beforeChicagoMidnight.getTime()}
      />,
    );

    try {
      expect(screen.getByTestId("messages-thread-day-sep")).toHaveTextContent(
        "Today, June 9",
      );
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(screen.getByTestId("messages-thread-day-sep")).toHaveTextContent(
        "Yesterday, June 9",
      );
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

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
    ["queued", "Queued · in Outbox"],
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

  it("labels every queued or paused Outbox row even when it is not the latest outbound", () => {
    render(
      <MessagesThread
        initial={[
          makeMessage({
            id: "older-queued",
            direction: "outbound",
            status: "queued",
            body: "queued body",
            created_at: "2026-06-09T12:00:00.000Z",
          }),
          makeMessage({
            id: "older-paused",
            direction: "outbound",
            status: "paused",
            body: "paused body",
            created_at: "2026-06-09T12:01:00.000Z",
          }),
          makeMessage({
            id: "newer-inbound",
            direction: "inbound",
            body: "newer reply",
            created_at: "2026-06-09T12:02:00.000Z",
          }),
        ]}
        contactId="contact-1"
        propertyId="property-1"
      />,
    );

    const labels = screen.getAllByTestId("messages-thread-delivery-status");
    expect(labels.map((label) => label.textContent)).toEqual([
      "Queued · in Outbox",
      "Paused · in Outbox",
    ]);
  });

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
    expect(icon).toHaveAttribute("title", "Sandra replied · confidence 92%");
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

    expect(
      screen.getAllByTestId("messages-thread-sandra-reply-icon"),
    ).toHaveLength(2);
  });
});
