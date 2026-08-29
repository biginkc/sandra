import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  createContactFromUnknownHelper,
  createPropertyAndResolve,
  recordLeadEvent,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  createContactFromUnknownHelper: vi.fn(),
  createPropertyAndResolve: vi.fn(),
  recordLeadEvent: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    LEAD_CREATED: "lead_created",
    QUEUED_MESSAGE_DELETED: "queued_message_deleted",
  },
  recordLeadEvent,
}));
vi.mock("@/lib/messages/triage", () => ({
  createContactFromUnknown: createContactFromUnknownHelper,
  dismissUnknownSender: vi.fn(),
  matchUnknownSender: vi.fn(),
  mergeUnknownSenderToProperty: vi.fn(),
  restoreDismissedSender: vi.fn(),
}));
vi.mock("@/lib/messages/resolve", () => ({
  createPropertyAndResolve,
  resolveThreadToExistingProperty: vi.fn(),
}));

import {
  createContactFromUnknownAction,
  createPropertyAndResolveAction,
  deleteQueuedMessage,
} from "./actions";

function makeClient(options?: {
  userId?: string | null;
  row?: { id: string; property_id: string | null } | null;
  error?: { message: string } | null;
}) {
  const eq = vi.fn();
  const maybeSingle = vi.fn().mockResolvedValue({
    data: options?.row ?? null,
    error: options?.error ?? null,
  });
  const query = {
    eq,
    select: vi.fn(() => query),
    maybeSingle,
  };
  eq.mockReturnValue(query);
  const deleteRow = vi.fn(() => query);
  return {
    client: {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user:
              options?.userId === null
                ? null
                : { id: options?.userId ?? "user-1" },
          },
        }),
      },
      from: vi.fn(() => ({ delete: deleteRow })),
    },
    deleteRow,
    eq,
  };
}

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_ID = "22222222-2222-4222-8222-222222222222";

describe("deleteQueuedMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a body-free event only after a queued property message is deleted", async () => {
    const { client, eq } = makeClient({
      row: { id: MESSAGE_ID, property_id: PROPERTY_ID },
    });
    createClient.mockResolvedValue(client);

    await expect(deleteQueuedMessage(MESSAGE_ID)).resolves.toEqual({
      ok: true,
      data: null,
    });

    expect(eq).toHaveBeenCalledWith("id", MESSAGE_ID);
    expect(eq).toHaveBeenCalledWith("status", "queued");
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: PROPERTY_ID,
      eventType: "queued_message_deleted",
      actorType: "user",
      actorId: "user-1",
      sourceType: "messages.deleted",
      sourceId: MESSAGE_ID,
    });
  });

  it("does not record an event when no queued row was deleted", async () => {
    const { client } = makeClient({ row: null });
    createClient.mockResolvedValue(client);

    const result = await deleteQueuedMessage(MESSAGE_ID);

    expect(result.ok).toBe(false);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("fails before deletion when the caller is not signed in", async () => {
    const { client, deleteRow } = makeClient({ userId: null });
    createClient.mockResolvedValue(client);

    const result = await deleteQueuedMessage(MESSAGE_ID);

    expect(result.ok).toBe(false);
    expect(deleteRow).not.toHaveBeenCalled();
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("allows a propertyless queued deletion without fabricating a lead event", async () => {
    const { client } = makeClient({
      row: { id: MESSAGE_ID, property_id: null },
    });
    createClient.mockResolvedValue(client);

    await expect(deleteQueuedMessage(MESSAGE_ID)).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not record an event when the guarded delete fails", async () => {
    const { client } = makeClient({ error: { message: "delete failed" } });
    createClient.mockResolvedValue(client);

    const result = await deleteQueuedMessage(MESSAGE_ID);

    expect(result).toEqual({
      ok: false,
      error: { code: "DELETE_FAILED", message: "delete failed" },
    });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
});

describe("message property creation activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a lead-created event after unknown-sender triage succeeds", async () => {
    const { client } = makeClient({ userId: "user-1" });
    createClient.mockResolvedValue(client);
    createContactFromUnknownHelper.mockResolvedValue({
      ok: true,
      data: { contactId: "contact-1", propertyId: PROPERTY_ID },
    });

    const result = await createContactFromUnknownAction({
      fromAddress: "+15555550101",
      role: "homeowner",
      contact: { firstName: "Synthetic" },
      property: { address: "1 Test St", state: "MO" },
    });

    expect(result.ok).toBe(true);
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: PROPERTY_ID,
      actorType: "user",
      actorId: "user-1",
      eventType: "lead_created",
      payload: { source: "unknown_sender" },
      sourceType: "properties.created",
      sourceId: PROPERTY_ID,
    });
  });

  it("does not triage or record when the caller is unauthenticated", async () => {
    const { client } = makeClient({ userId: null });
    createClient.mockResolvedValue(client);

    const result = await createContactFromUnknownAction({
      fromAddress: "+15555550101",
      role: "homeowner",
      contact: {},
      property: { address: "1 Test St", state: "MO" },
    });

    expect(result.ok).toBe(false);
    expect(createContactFromUnknownHelper).not.toHaveBeenCalled();
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not record a lead-created event when unknown-sender triage fails", async () => {
    const { client } = makeClient({ userId: "user-1" });
    createClient.mockResolvedValue(client);
    createContactFromUnknownHelper.mockResolvedValue({
      ok: false,
      error: { code: "PROPERTY_INSERT_FAILED", message: "failed" },
    });

    await createContactFromUnknownAction({
      fromAddress: "+15555550101",
      role: "homeowner",
      contact: {},
      property: { address: "1 Test St", state: "MO" },
    });

    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("records a lead-created event only after create-and-resolve succeeds", async () => {
    const { client } = makeClient({ userId: "user-2" });
    createClient.mockResolvedValue(client);
    createPropertyAndResolve.mockResolvedValue({
      ok: true,
      data: {
        updated: 2,
        conversationId: "conversation-1",
        propertyId: PROPERTY_ID,
      },
    });

    const result = await createPropertyAndResolveAction({
      sourceConversationId: "source-1",
      contactId: "contact-1",
      role: "homeowner",
      property: { address: "2 Test St", state: "MO" },
    });

    expect(result.ok).toBe(true);
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: PROPERTY_ID,
      actorType: "user",
      actorId: "user-2",
      eventType: "lead_created",
      payload: { source: "message_resolution" },
      sourceType: "properties.created",
      sourceId: PROPERTY_ID,
    });
  });

  it("does not record create-and-resolve failures", async () => {
    const { client } = makeClient({ userId: "user-2" });
    createClient.mockResolvedValue(client);
    createPropertyAndResolve.mockResolvedValue({
      ok: false,
      error: { code: "MESSAGE_UPDATE_FAILED", message: "failed" },
    });

    await createPropertyAndResolveAction({
      sourceConversationId: "source-1",
      contactId: "contact-1",
      role: "homeowner",
      property: { address: "2 Test St", state: "MO" },
    });

    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
});
