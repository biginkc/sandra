import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

import { getRecentNotifications } from "./notifications";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_ID = "22222222-2222-4222-8222-222222222222";

describe("getRecentNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the message-thread href from the conversation id", async () => {
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
        }),
      },
      from: vi.fn((table: string) => {
        if (table === "notifications") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue({
                    data: [
                      {
                        id: "notification-1",
                        event_type: "owner_message_added",
                        entity_type: "message",
                        entity_id: "message-1",
                        title: "New SMS reply",
                        body: "123 Main St",
                        read_at: null,
                        created_at: "2026-06-09T12:00:00.000Z",
                      },
                    ],
                    error: null,
                  }),
                })),
              })),
            })),
          };
        }

        if (table === "messages") {
          return {
            select: vi.fn(() => ({
              in: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: "message-1",
                    conversation_id: "55555555-5555-4555-8555-555555555555",
                    contact_id: CONTACT_ID,
                    property_id: PROPERTY_ID,
                  },
                ],
                error: null,
              }),
            })),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    });

    const result = await getRecentNotifications(10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      expect.objectContaining({
        id: "notification-1",
        entityId: "message-1",
        href: `/messages?thread=${encodeURIComponent("55555555-5555-4555-8555-555555555555")}`,
      }),
    ]);
  });
});
