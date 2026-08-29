import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const { afterMock, loadIntegrationPrefs } = vi.hoisted(() => ({
  afterMock: vi.fn((callback: () => Promise<void> | void) => {
    void callback;
  }),
  loadIntegrationPrefs: vi.fn(async () => ({
    slackEnabled: false,
    calendarEnabled: false,
    timezone: "America/Chicago",
  })),
}));

vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));

import { completeTask, createTask, reassignTask, snoozeTask } from "./index";

const testClient = createTestClient();
const createdAuthUsers: string[] = [];

async function createActiveMember(label: string): Promise<string> {
  const { data, error } = await testClient.auth.admin.createUser({
    email: `${label}-${randomUUID()}@test.invalid`,
    password: `test-pw-${randomUUID()}`,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`auth user seed failed: ${error?.message}`);
  }
  createdAuthUsers.push(data.user.id);

  const { error: membershipError } = await testClient
    .from("memberships")
    .insert({
      org_id: BMH_ORG_ID,
      user_id: data.user.id,
      role: "member",
      access_status: "active",
    });
  if (membershipError) {
    throw new Error(`membership seed failed: ${membershipError.message}`);
  }
  return data.user.id;
}

async function seedProperty(address: string): Promise<string> {
  const { data, error } = await testClient
    .from("properties")
    .insert({
      org_id: BMH_ORG_ID,
      address,
      state: "MO",
      status: "prospect",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("property seed failed");
  return data.id;
}

describe("task lead events (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    await seedTwoOrgs(testClient);
  });

  afterEach(async () => {
    for (const userId of createdAuthUsers) {
      await testClient.auth.admin.deleteUser(userId);
    }
    createdAuthUsers.length = 0;
  });

  it("persists one truthful event for each property-linked task transition and none for retries or failures", async () => {
    const actorId = await createActiveMember("task-event-actor");
    const nextAssigneeId = await createActiveMember("task-event-assignee");
    const propertyId = await seedProperty("41 Task Event Ln");
    const originalDueAt = "2026-09-01T15:00:00.000Z";
    const snoozedUntil = "2026-09-02T15:00:00.000Z";

    const created = await createTask(testClient, {
      orgId: BMH_ORG_ID,
      assigneeId: actorId,
      relatedPropertyId: propertyId,
      type: "follow_up",
      title: "Private task title",
      description: "Private task description",
      dueAt: originalDueAt,
      createdBy: actorId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(
      await snoozeTask(testClient, created.data.id, snoozedUntil, actorId),
    ).toMatchObject({ ok: true });
    expect(
      await snoozeTask(testClient, created.data.id, snoozedUntil, actorId),
    ).toMatchObject({ ok: true });
    expect(
      await reassignTask(testClient, created.data.id, nextAssigneeId, actorId),
    ).toMatchObject({ ok: true });
    expect(
      await reassignTask(testClient, created.data.id, nextAssigneeId, actorId),
    ).toMatchObject({ ok: true });
    expect(
      await completeTask(testClient, created.data.id, actorId),
    ).toMatchObject({ ok: true });
    expect(
      await completeTask(testClient, created.data.id, actorId),
    ).toMatchObject({ ok: true });

    // Completion is terminal for generic snooze, and still adds no history.
    expect(
      await snoozeTask(
        testClient,
        created.data.id,
        "2026-09-04T15:00:00.000Z",
        actorId,
      ),
    ).toMatchObject({ ok: false });

    // A rejected mutation must not create history either.
    const failedReassign = await reassignTask(
      testClient,
      created.data.id,
      randomUUID(),
      actorId,
    );
    expect(failedReassign.ok).toBe(false);

    const { data: events, error: eventsError } = await testClient
      .from("lead_events")
      .select(
        "event_type, actor_type, actor_id, payload, source_type, source_id",
      )
      .eq("property_id", propertyId);
    expect(eventsError).toBeNull();
    expect(events).toHaveLength(4);

    const byType = new Map(
      (events ?? []).map((event) => [event.event_type, event]),
    );
    expect([...byType.keys()].sort()).toEqual([
      "task_completed",
      "task_created",
      "task_reassigned",
      "task_snoozed",
    ]);
    for (const event of events ?? []) {
      expect(event.actor_type).toBe("user");
      expect(event.actor_id).toBe(actorId);
      expect(JSON.stringify(event.payload)).not.toContain("Private task");
    }
    const createdEvent = byType.get("task_created");
    expect(createdEvent).toMatchObject({
      source_type: "tasks.created",
      source_id: created.data.id,
      payload: {
        task_id: created.data.id,
        task_type: "follow_up",
        assignee_id: actorId,
      },
    });
    const createdPayload = createdEvent?.payload as Record<string, unknown>;
    expect(new Date(String(createdPayload.due_at)).toISOString()).toBe(
      originalDueAt,
    );

    const snoozedPayload = byType.get("task_snoozed")?.payload as Record<
      string,
      unknown
    >;
    expect(snoozedPayload).toMatchObject({
      task_id: created.data.id,
    });
    expect(new Date(String(snoozedPayload.from)).toISOString()).toBe(
      originalDueAt,
    );
    expect(new Date(String(snoozedPayload.to)).toISOString()).toBe(
      snoozedUntil,
    );
    expect(byType.get("task_reassigned")?.payload).toEqual({
      task_id: created.data.id,
      from: actorId,
      to: nextAssigneeId,
    });
    expect(byType.get("task_completed")?.payload).toEqual({
      task_id: created.data.id,
      from: "open",
      to: "completed",
    });
  });

  it("keeps propertyless appointments out of the generic task ledger", async () => {
    const actorId = await createActiveMember("propertyless-task-actor");
    const result = await createTask(testClient, {
      orgId: BMH_ORG_ID,
      assigneeId: actorId,
      type: "appointment",
      title: "Personal block",
      dueAt: "2026-09-03T15:00:00.000Z",
      endAt: "2026-09-03T15:30:00.000Z",
      createdBy: actorId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { count, error } = await testClient
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("source_type", "tasks.created")
      .eq("source_id", result.data.id);
    expect(error).toBeNull();
    expect(count).toBe(0);
  });
});
