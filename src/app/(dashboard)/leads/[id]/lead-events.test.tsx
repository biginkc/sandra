import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  callbackByEvent,
  channelTopics,
  channelOn,
  order,
  queryResult,
  queryResponses,
  realtimeOrder,
  removeChannel,
  setAuth,
  subscriptionConfig,
} = vi.hoisted(() => ({
  callbackByEvent: {} as Record<
    string,
    ((payload: { new: unknown }) => void) | undefined
  >,
  channelTopics: [] as string[],
  channelOn: vi.fn(),
  order: vi.fn(),
  queryResult: { data: [] as unknown[], error: null as unknown },
  queryResponses: [] as Array<Promise<{ data: unknown[]; error: unknown }>>,
  realtimeOrder: [] as string[],
  removeChannel: vi.fn(),
  setAuth: vi.fn(),
  subscriptionConfig: {} as Record<string, unknown>,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: order.mockImplementation(() => query),
      limit: vi.fn(
        () => queryResponses.shift() ?? Promise.resolve(queryResult),
      ),
    };
    const channel = {
      on: channelOn.mockImplementation(
        (
          _kind: string,
          config: Record<string, unknown>,
          callback: (payload: { new: unknown }) => void,
        ) => {
          Object.assign(subscriptionConfig, config);
          callbackByEvent[String(config.event)] = callback;
          return channel;
        },
      ),
      subscribe: vi.fn((callback?: (status: string) => void) => {
        realtimeOrder.push("subscribe");
        callback?.("SUBSCRIBED");
        return channel;
      }),
    };
    return {
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "test-token" } },
        })),
      },
      channel: vi.fn((topic: string) => {
        channelTopics.push(topic);
        return channel;
      }),
      from: vi.fn(() => query),
      realtime: {
        setAuth: setAuth.mockImplementation(() => {
          realtimeOrder.push("setAuth");
        }),
      },
      removeChannel,
    };
  },
}));

import {
  formatLeadEventSentence,
  LeadEventPill,
  type LeadEvent,
  useLeadEvents,
} from "./lead-events";

function makeEvent(
  id: string,
  createdAt: string,
  overrides: Partial<LeadEvent> = {},
): LeadEvent {
  return {
    id,
    property_id: "property-1",
    actor_type: "user",
    actor_id: "user-1",
    event_type: "status_changed",
    payload: { from: "new_lead", to: "contacted" },
    created_at: createdAt,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  realtimeOrder.length = 0;
  channelTopics.length = 0;
  queryResult.data = [];
  queryResult.error = null;
  queryResponses.length = 0;
  for (const key of Object.keys(callbackByEvent)) delete callbackByEvent[key];
  for (const key of Object.keys(subscriptionConfig))
    delete subscriptionConfig[key];
});

describe("<LeadEventPill />", () => {
  it("renders a whitelisted plain-English change with actor and bulk context", () => {
    render(
      <LeadEventPill
        event={makeEvent("tag", "2026-08-25T17:00:00.000Z", {
          event_type: "tag_applied",
          payload: {
            label: "Hot",
            batch_id: "batch-1",
            batch_count: 7,
          },
        })}
        authorEmails={{ "user-1": "jarrad@example.com" }}
        currentUserId="user-1"
      />,
    );

    expect(screen.getByTestId("lead-event-row")).toHaveTextContent(
      "You added tag Hot with 6 others",
    );
    expect(screen.getByTestId("lead-event-row")).not.toHaveTextContent(
      "batch-1",
    );
    expect(
      formatLeadEventSentence(
        makeEvent("pause", "2026-08-25T17:00:00.000Z", {
          actor_type: "system",
          actor_id: null,
          event_type: "sequence_paused",
          payload: {
            count: 2,
            batch_id: "batch-2",
            batch_count: 5,
          },
        }),
        {},
        null,
      ),
    ).toBe("System paused 2 sequences with 4 others");
  });

  it("labels actors and assignment transitions without exposing user ids", () => {
    const base = makeEvent("actor", "2026-08-25T17:00:00.000Z", {
      event_type: "qualified",
      payload: {},
    });
    const authorEmails = {
      "user-1": "jarrad@example.com",
      "user-2": "sandra.operator@example.com",
    };

    expect(
      formatLeadEventSentence(
        { ...base, actor_type: "system", actor_id: null },
        authorEmails,
        "user-1",
      ),
    ).toBe("System qualified the lead");
    expect(
      formatLeadEventSentence(
        { ...base, actor_type: "ai", actor_id: null },
        authorEmails,
        "user-1",
      ),
    ).toBe("Sandra qualified the lead");
    expect(
      formatLeadEventSentence(
        { ...base, actor_type: "user", actor_id: null },
        authorEmails,
        "user-1",
      ),
    ).toBe("Former teammate qualified the lead");

    const knownAssignment = formatLeadEventSentence(
      {
        ...base,
        actor_type: "user",
        actor_id: "user-1",
        event_type: "assigned",
        payload: { from: "user-2", to: "user-1" },
      },
      authorEmails,
      "user-1",
    );
    const unknownAssignment = formatLeadEventSentence(
      {
        ...base,
        actor_type: "user",
        actor_id: "user-1",
        event_type: "assigned",
        payload: { from: "unknown-user-uuid", to: null },
      },
      authorEmails,
      "user-1",
    );
    expect(knownAssignment).toBe("You changed assignee: sandra.operator → you");
    expect(unknownAssignment).toBe(
      "You changed assignee: a teammate → unassigned",
    );
    expect(`${knownAssignment} ${unknownAssignment}`).not.toMatch(
      /example\.com|user-1|user-2|unknown-user-uuid/,
    );
  });

  it("renders unknown and malformed events without exposing payloads or ids", () => {
    render(
      <LeadEventPill
        event={makeEvent("event-secret", "2026-08-25T17:00:00.000Z", {
          actor_id: "actor-secret",
          event_type: "future_internal_event",
          payload: {
            body: "private body",
            address: "private address",
            phone: "private phone",
          },
        })}
        authorEmails={{}}
        currentUserId={null}
      />,
    );

    const row = screen.getByTestId("lead-event-row");
    expect(row).toHaveTextContent("Unknown teammate recorded activity");
    for (const secret of [
      "private body",
      "private address",
      "private phone",
      "event-secret",
      "actor-secret",
      "future internal event",
    ]) {
      expect(row).not.toHaveTextContent(secret);
    }

    for (const eventType of [
      "status_changed",
      "motivation_changed",
      "assigned",
      "task_reassigned",
      "appointment_reassigned",
      "sequence_paused",
      "sequence_resumed",
      "dispo_set",
      "ai_responder_toggled",
      "skip_trace_toggled",
    ]) {
      expect(
        formatLeadEventSentence(
          makeEvent(`malformed-${eventType}`, "2026-08-25T17:00:00.000Z", {
            actor_type: "system",
            actor_id: null,
            event_type: eventType,
            payload: {},
          }),
          {},
          null,
        ),
      ).toBe("System recorded activity");
    }

    for (const [eventType, payload] of [
      ["status_changed", { from: true, to: false }],
      ["status_changed", { from: "", to: "contacted" }],
      ["motivation_changed", { from: "hot", to: "   " }],
      ["motivation_changed", { from: 1, to: 2 }],
      ["dispo_set", { from: {}, to: { invalid: true } }],
      ["assigned", { from: "", to: "user-1" }],
      ["assigned", { from: null, to: "   " }],
      ["task_reassigned", { to: "" }],
      ["appointment_reassigned", { to: "   " }],
    ] as const) {
      expect(
        formatLeadEventSentence(
          makeEvent(`invalid-${eventType}`, "2026-08-25T17:00:00.000Z", {
            actor_type: "system",
            actor_id: null,
            event_type: eventType,
            payload,
          }),
          {},
          null,
        ),
      ).toBe("System recorded activity");
    }

    expect(
      formatLeadEventSentence(
        makeEvent("single-resume", "2026-08-25T17:00:00.000Z", {
          actor_type: "system",
          actor_id: null,
          event_type: "sequence_resumed",
          payload: {
            enrollment_id: "enrollment-1",
            sequence_id: "sequence-1",
            next_run_at: "2026-08-26T17:00:00.000Z",
          },
        }),
        {},
        null,
      ),
    ).toBe("System resumed a sequence");
    expect(
      formatLeadEventSentence(
        makeEvent("bulk-resume", "2026-08-25T17:00:00.000Z", {
          actor_type: "system",
          actor_id: null,
          event_type: "sequence_resumed",
          payload: { count: 2, sequence_ids: ["sequence-1", "sequence-2"] },
        }),
        {},
        null,
      ),
    ).toBe("System resumed 2 sequences");
  });
});

describe("useLeadEvents", () => {
  it("authenticates, filters, reconciles, deduplicates, bounds, and cleans up", async () => {
    const initial = Array.from({ length: 200 }, (_, index) =>
      makeEvent(
        `event-${index}`,
        `2026-08-25T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
      ),
    );
    const { result, unmount } = renderHook(() =>
      useLeadEvents({ propertyId: "property-1", initial }),
    );
    await waitFor(() => expect(callbackByEvent.INSERT).toBeDefined());
    await waitFor(() => expect(result.current.reconciled).toBe(true));

    expect(realtimeOrder).toEqual(["setAuth", "subscribe"]);
    expect(setAuth).toHaveBeenCalledWith("test-token");
    expect(subscriptionConfig).toMatchObject({
      event: "INSERT",
      schema: "public",
      table: "lead_events",
      filter: "property_id=eq.property-1",
    });
    expect(order).toHaveBeenNthCalledWith(1, "created_at", {
      ascending: false,
    });
    expect(order).toHaveBeenNthCalledWith(2, "id", { ascending: false });

    const inserted = makeEvent("event-new", "2026-08-25T14:00:00.000Z");
    act(() => callbackByEvent.INSERT!({ new: inserted }));
    act(() =>
      callbackByEvent.INSERT!({
        new: { ...inserted, payload: { from: "contacted", to: "nurture" } },
      }),
    );
    act(() =>
      callbackByEvent.INSERT!({
        new: makeEvent("wrong-property", "2026-08-25T15:00:00.000Z", {
          property_id: "property-2",
        }),
      }),
    );

    expect(result.current.events).toHaveLength(200);
    expect(result.current.events.at(-1)).toMatchObject({
      id: "event-new",
      payload: { from: "contacted", to: "nurture" },
    });
    expect(
      result.current.events.filter((event) => event.id === "event-new"),
    ).toHaveLength(1);
    expect(result.current.events.some((event) => event.id === "event-0")).toBe(
      false,
    );
    expect(
      result.current.events.some((event) => event.id === "wrong-property"),
    ).toBe(false);

    unmount();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it("merges a row created before the realtime subscription became active", async () => {
    const catchUp = makeEvent("catch-up", "2026-08-25T13:00:00.000Z");
    const initial: LeadEvent[] = [];
    queryResult.data = [catchUp];

    const { result } = renderHook(() =>
      useLeadEvents({ propertyId: "property-1", initial }),
    );

    await waitFor(() => expect(result.current.reconciled).toBe(true));
    expect(result.current.events).toEqual([catchUp]);
  });

  it("does not erase a realtime insert when a same-property retry snapshot arrives", async () => {
    const initial: LeadEvent[] = [
      makeEvent("existing", "2026-08-25T13:00:00.000Z"),
    ];
    const retrySnapshot: LeadEvent[] = [...initial];
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: LeadEvent[] }) =>
        useLeadEvents({
          propertyId: "property-1",
          initial: snapshot,
          serverSnapshot: initial,
        }),
      { initialProps: { snapshot: initial } },
    );
    await waitFor(() => expect(callbackByEvent.INSERT).toBeDefined());
    const concurrent = makeEvent("concurrent", "2026-08-25T14:00:00.000Z");

    act(() => callbackByEvent.INSERT!({ new: concurrent }));
    rerender({ snapshot: retrySnapshot });

    expect(result.current.events).toEqual([initial[0], concurrent]);
  });

  it("reconciles a failed same-property server refresh while retaining displayed rows", async () => {
    const first: LeadEvent[] = [makeEvent("first", "2026-08-25T13:00:00.000Z")];
    const firstServerSnapshot = [...first];
    const failedServerSnapshot: LeadEvent[] = [];
    let resolveCatchUp!: (value: { data: unknown[]; error: unknown }) => void;
    const { result, rerender } = renderHook(
      ({ serverSnapshot }: { serverSnapshot: LeadEvent[] }) =>
        useLeadEvents({
          propertyId: "property-1",
          initial: first,
          serverSnapshot,
        }),
      { initialProps: { serverSnapshot: firstServerSnapshot } },
    );

    await waitFor(() => expect(result.current.reconciled).toBe(true));
    queryResponses.push(
      new Promise((resolve) => {
        resolveCatchUp = resolve;
      }),
    );
    rerender({ serverSnapshot: failedServerSnapshot });

    await waitFor(() => expect(result.current.reconciled).toBe(false));
    expect(result.current.events).toEqual(first);
    expect(order).toHaveBeenCalledTimes(4);
    expect(channelTopics).toHaveLength(2);
    expect(channelTopics[1]).not.toBe(channelTopics[0]);

    resolveCatchUp({ data: [], error: null });
    await waitFor(() => expect(result.current.reconciled).toBe(true));
    expect(result.current.events).toEqual(first);
  });
});
