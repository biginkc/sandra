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

  // Codex round 11 (finding 2): `entity_type='task'` notifications used to
  // hard-route to `/tasks` (a route with no page.tsx — a guaranteed 404)
  // regardless of event type. Appointment-reminder bell clicks are now
  // linkage-aware, mirroring the reminder Slack CTA's routing
  // (`buildAppointmentDeepLink`, reminders.ts). Route-level coverage
  // across all three linkages the claimed task row can carry.
  describe("task_appointment_reminder bell click-through (Codex round 11, finding 2)", () => {
    function mockNotificationsAndTasks(
      taskRow: { id: string; related_property_id: string | null; contact_id: string | null },
    ) {
      createClient.mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
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
                          event_type: "task_appointment_reminder",
                          entity_type: "task",
                          entity_id: taskRow.id,
                          title: "Appointment in 30 min",
                          body: "Walkthrough with seller",
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
          if (table === "tasks") {
            return {
              select: vi.fn(() => ({
                in: vi.fn().mockResolvedValue({ data: [taskRow], error: null }),
              })),
            };
          }
          throw new Error(`Unexpected table: ${table}`);
        }),
      });
    }

    it("property-linked -> /leads/<propertyId>", async () => {
      mockNotificationsAndTasks({
        id: "task-1",
        related_property_id: PROPERTY_ID,
        contact_id: null,
      });

      const result = await getRecentNotifications(10);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([
        expect.objectContaining({ entityId: "task-1", href: `/leads/${PROPERTY_ID}` }),
      ]);
    });

    it("contact-only -> /messages?thread=<contactId>", async () => {
      mockNotificationsAndTasks({
        id: "task-1",
        related_property_id: null,
        contact_id: CONTACT_ID,
      });

      const result = await getRecentNotifications(10);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([
        expect.objectContaining({
          entityId: "task-1",
          href: `/messages?thread=${encodeURIComponent(CONTACT_ID)}`,
        }),
      ]);
    });

    it("personal block (neither linkage) -> /dashboard", async () => {
      mockNotificationsAndTasks({
        id: "task-1",
        related_property_id: null,
        contact_id: null,
      });

      const result = await getRecentNotifications(10);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([
        expect.objectContaining({ entityId: "task-1", href: "/dashboard" }),
      ]);
    });
  });
});
