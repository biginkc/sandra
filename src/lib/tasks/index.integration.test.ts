import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

import { completeTask, reassignTask } from "./index";

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
    // Writers create through fn_create_next_step now; this row is seeded directly as a generic task.
    const { data: seeded, error: seedError } = await testClient
      .from("tasks")
      .insert({
        org_id: BMH_ORG_ID,
        assignee_id: actorId,
        related_property_id: propertyId,
        type: "custom",
        title: "Private task title",
        description: "Private task description",
        due_at: "2026-09-01T15:00:00.000Z",
        created_by: actorId,
      })
      .select("id")
      .single();
    if (seedError || !seeded) throw seedError ?? new Error("task seed failed");
    const created = { data: { id: seeded.id } };

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
    expect(events).toHaveLength(2);

    const byType = new Map(
      (events ?? []).map((event) => [event.event_type, event]),
    );
    expect([...byType.keys()].sort()).toEqual([
      "task_completed",
      "task_reassigned",
    ]);
    for (const event of events ?? []) {
      expect(event.actor_type).toBe("user");
      expect(event.actor_id).toBe(actorId);
      expect(JSON.stringify(event.payload)).not.toContain("Private task");
    }
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
});
