import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";
import {
  BMH_ORG_ID,
  createOrgUser,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const serviceClient = createTestClient();
const migrationSql = readFileSync(
  "supabase/migrations/20260825220000_lead_events_historical_backfill.sql",
  "utf8",
);
let pg: Client;
let actorId = "";
let ownerId = "";

function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) throw new Error("Missing TEST_SUPABASE_DB_URL");
  return url;
}

async function insertProperty(input: {
  address: string;
  createdAt: string;
  homeownerContactId?: string;
  qualifiedAt?: string;
  qualifiedBy?: string;
}): Promise<string> {
  const { data, error } = await serviceClient
    .from("properties")
    .insert({
      org_id: BMH_ORG_ID,
      address: input.address,
      state: "MO",
      status: input.qualifiedAt ? "new_lead" : "prospect",
      source: "referral",
      created_at: input.createdAt,
      homeowner_contact_id: input.homeownerContactId ?? null,
      qualified_at: input.qualifiedAt ?? null,
      qualified_by: input.qualifiedBy ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("property insert failed");
  return data.id;
}

async function insertContact(label: string): Promise<string> {
  const { data, error } = await serviceClient
    .from("contacts")
    .insert({
      org_id: BMH_ORG_ID,
      first_name: label,
      last_name: "Backfill",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("contact insert failed");
  return data.id;
}

async function insertAppointment(input: {
  propertyId: string;
  label: string;
  createdAt: string;
  dueAt: string;
  chainId?: string;
}): Promise<{ id: string; chainId: string }> {
  const chainId = input.chainId ?? crypto.randomUUID();
  const endAt = new Date(new Date(input.dueAt).getTime() + 30 * 60_000);
  const { data, error } = await serviceClient
    .from("tasks")
    .insert({
      org_id: BMH_ORG_ID,
      assignee_id: actorId,
      related_property_id: input.propertyId,
      type: "appointment",
      status: "open",
      title: `Private ${input.label} appointment title`,
      description: `Private ${input.label} appointment description`,
      due_at: input.dueAt,
      end_at: endAt.toISOString(),
      calendar_chain_id: chainId,
      created_by: actorId,
      created_at: input.createdAt,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("appointment insert failed");
  return { id: data.id, chainId };
}

async function runBackfill(): Promise<void> {
  await pg.query(migrationSql);
}

beforeAll(async () => {
  await resetTenantTables(serviceClient);
  const { data: owner, error: ownerError } = await serviceClient
    .from("memberships")
    .select("user_id")
    .eq("org_id", BMH_ORG_ID)
    .eq("role", "owner")
    .limit(1)
    .single();
  if (ownerError || !owner) throw ownerError ?? new Error("owner missing");
  ownerId = owner.user_id;
  const actor = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: `lead-event-backfill-${crypto.randomUUID()}@bmhgroupkc.com`,
    role: "member",
  });
  actorId = actor.userId;
  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
});

beforeEach(async () => {
  await resetTenantTables(serviceClient);
});

afterAll(async () => {
  await serviceClient.auth.admin.deleteUser(actorId);
  await resetTenantTables(serviceClient);
  await pg.end();
});

describe("Migration 20260825220000 — lead event historical backfill", () => {
  it("backfills only durable property, task, appointment, and consent facts with source timestamps", async () => {
    const times = {
      property: "2026-01-02T15:00:00.000Z",
      qualified: "2026-01-03T16:00:00.000Z",
      taskCreated: "2026-01-04T17:00:00.000Z",
      taskCompleted: "2026-01-05T18:00:00.000Z",
      appointmentCreated: "2026-01-06T19:00:00.000Z",
      appointmentBooked: "2026-01-06T19:01:00.000Z",
      appointmentHeld: "2026-01-07T20:00:00.000Z",
      appointmentNoShow: "2026-01-07T20:30:00.000Z",
      appointmentCanceled: "2026-01-07T21:00:00.000Z",
      appointmentRescheduled: "2026-01-07T21:30:00.000Z",
      appointmentReassigned: "2026-01-06T19:01:30.000Z",
      optedOut: "2026-01-08T21:00:00.000Z",
      consentCaptured: "2026-01-08T22:00:00.000Z",
    };
    const contactId = await insertContact("Unique");
    const propertyId = await insertProperty({
      address: "1 Historical Ledger Ln",
      createdAt: times.property,
      homeownerContactId: contactId,
      qualifiedAt: times.qualified,
      qualifiedBy: actorId,
    });

    const { data: task, error: taskError } = await serviceClient
      .from("tasks")
      .insert({
        org_id: BMH_ORG_ID,
        assignee_id: actorId,
        related_property_id: propertyId,
        type: "follow_up",
        status: "completed",
        title: "Private task title",
        due_at: "2026-01-05T17:00:00.000Z",
        completed_at: times.taskCompleted,
        completed_by: actorId,
        created_by: actorId,
        created_at: times.taskCreated,
      })
      .select("id")
      .single();
    if (taskError || !task) throw taskError ?? new Error("task insert failed");
    const { error: mutableTaskUpdateError } = await serviceClient
      .from("tasks")
      .update({
        assignee_id: ownerId,
        due_at: "2026-02-05T17:00:00.000Z",
        type: "callback",
      })
      .eq("id", task.id);
    if (mutableTaskUpdateError) throw mutableTaskUpdateError;

    const appointment = await insertAppointment({
      propertyId,
      label: "held",
      createdAt: times.appointmentCreated,
      dueAt: "2026-01-07T19:00:00.000Z",
    });
    const noShow = await insertAppointment({
      propertyId,
      label: "no-show",
      createdAt: "2026-01-06T19:02:00.000Z",
      dueAt: "2026-01-07T19:30:00.000Z",
    });
    const canceled = await insertAppointment({
      propertyId,
      label: "canceled",
      createdAt: "2026-01-06T19:03:00.000Z",
      dueAt: "2026-01-07T20:00:00.000Z",
    });
    const rescheduleSource = await insertAppointment({
      propertyId,
      label: "reschedule source",
      createdAt: "2026-01-06T19:04:00.000Z",
      dueAt: "2026-01-07T20:30:00.000Z",
    });
    const rescheduleTarget = await insertAppointment({
      propertyId,
      label: "reschedule target",
      createdAt: times.appointmentRescheduled,
      dueAt: "2026-01-09T20:30:00.000Z",
      chainId: rescheduleSource.chainId,
    });
    const mutationIds = {
      booked: crypto.randomUUID(),
      canceled: crypto.randomUUID(),
      rescheduled: crypto.randomUUID(),
      reassigned: crypto.randomUUID(),
    };
    const { error: mutationError } = await serviceClient
      .from("task_calendar_mutations")
      .insert([
        {
          id: mutationIds.booked,
          org_id: BMH_ORG_ID,
          calendar_chain_id: appointment.chainId,
          operation: "create",
          phase: "finalized",
          source_task_id: appointment.id,
          old_assignee_id: actorId,
          expected_generation: 0,
          created_at: times.appointmentBooked,
        },
        {
          id: mutationIds.canceled,
          org_id: BMH_ORG_ID,
          calendar_chain_id: canceled.chainId,
          operation: "cancel",
          phase: "finalized",
          source_task_id: canceled.id,
          old_assignee_id: actorId,
          expected_generation: 0,
          created_at: times.appointmentCanceled,
        },
        {
          id: mutationIds.rescheduled,
          org_id: BMH_ORG_ID,
          calendar_chain_id: rescheduleSource.chainId,
          operation: "reschedule",
          phase: "finalized",
          source_task_id: rescheduleSource.id,
          target_task_id: rescheduleTarget.id,
          old_assignee_id: actorId,
          new_assignee_id: actorId,
          expected_generation: 0,
          created_at: times.appointmentRescheduled,
        },
        {
          id: mutationIds.reassigned,
          org_id: BMH_ORG_ID,
          calendar_chain_id: appointment.chainId,
          operation: "reassign",
          phase: "finalized",
          source_task_id: appointment.id,
          old_assignee_id: actorId,
          new_assignee_id: ownerId,
          expected_generation: 0,
          created_at: times.appointmentReassigned,
        },
      ]);
    if (mutationError) throw mutationError;
    await pg.query("begin");
    try {
      await pg.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      await pg.query(
        `update public.tasks
         set status = 'completed', outcome = 'held', completed_at = $2,
             completed_by = $3, updated_at = $2
         where id = $1`,
        [appointment.id, times.appointmentHeld, actorId],
      );
      await pg.query(
        `update public.tasks
         set status = 'completed', outcome = 'no_show', completed_at = $2,
             completed_by = $3, updated_at = $2
         where id = $1`,
        [noShow.id, times.appointmentNoShow, actorId],
      );
      await pg.query(
        `update public.tasks
         set status = 'cancelled', outcome = 'cancelled', updated_at = $2
         where id = $1`,
        [canceled.id, times.appointmentCanceled],
      );
      await pg.query(
        `update public.tasks
         set status = 'cancelled', outcome = 'rescheduled', completed_at = $2,
             completed_by = $3, updated_at = $2
         where id = $1`,
        [rescheduleSource.id, times.appointmentRescheduled, actorId],
      );
      await pg.query(
        `update public.tasks
         set assignee_id = $2, updated_at = $3
         where id = $1`,
        [appointment.id, ownerId, times.appointmentReassigned],
      );
      await pg.query("commit");
    } catch (error) {
      await pg.query("rollback");
      throw error;
    }

    const consentIds = {
      optedOut: crypto.randomUUID(),
      captured: crypto.randomUUID(),
    };
    const { error: consentError } = await serviceClient
      .from("consent_events")
      .insert([
        {
          id: consentIds.optedOut,
          org_id: BMH_ORG_ID,
          contact_id: contactId,
          channel: "sms",
          event_type: "opt_out",
          source: "historical_test",
          source_detail: { propertyId, private: "must not copy" },
          occurred_at: times.optedOut,
        },
        {
          id: consentIds.captured,
          org_id: BMH_ORG_ID,
          contact_id: contactId,
          channel: "sms",
          event_type: "opt_in_marketing_written",
          source: "historical_test",
          source_detail: { propertyId, private: "must not copy" },
          occurred_at: times.consentCaptured,
        },
      ]);
    if (consentError) throw consentError;

    await runBackfill();
    const { data: events, error: eventsError } = await serviceClient
      .from("lead_events")
      .select(
        "actor_type, actor_id, event_type, payload, source_type, source_id, created_at",
      )
      .eq("property_id", propertyId)
      .order("created_at");
    expect(eventsError).toBeNull();
    expect(events?.map((event) => event.event_type)).toEqual([
      "lead_created",
      "qualified",
      "task_created",
      "task_completed",
      "appointment_booked",
      "appointment_reassigned",
      "appointment_held",
      "appointment_no_show",
      "appointment_canceled",
      "appointment_rescheduled",
      "opted_out",
      "consent_captured",
    ]);
    expect(
      events?.map((event) => new Date(event.created_at).toISOString()),
    ).toEqual([
      times.property,
      times.qualified,
      times.taskCreated,
      times.taskCompleted,
      times.appointmentBooked,
      times.appointmentReassigned,
      times.appointmentHeld,
      times.appointmentNoShow,
      times.appointmentCanceled,
      times.appointmentRescheduled,
      times.optedOut,
      times.consentCaptured,
    ]);
    const bySource = new Map(
      events?.map((event) => [
        `${event.source_type}:${event.source_id}`,
        event,
      ]) ?? [],
    );
    const normalizedEvent = (sourceType: string, sourceId: string) => {
      const event = bySource.get(`${sourceType}:${sourceId}`);
      expect(event).toBeDefined();
      return {
        ...event!,
        created_at: new Date(event!.created_at).toISOString(),
      };
    };
    expect(normalizedEvent("properties.created", propertyId)).toEqual({
      actor_type: "system",
      actor_id: null,
      event_type: "lead_created",
      payload: { source: "referral" },
      source_type: "properties.created",
      source_id: propertyId,
      created_at: times.property,
    });
    expect(normalizedEvent("properties.qualified", propertyId)).toEqual({
      actor_type: "user",
      actor_id: actorId,
      event_type: "qualified",
      payload: { from: "prospect", to: "new_lead" },
      source_type: "properties.qualified",
      source_id: propertyId,
      created_at: times.qualified,
    });
    expect(normalizedEvent("tasks.created", task.id)).toEqual({
      actor_type: "user",
      actor_id: actorId,
      event_type: "task_created",
      payload: { task_id: task.id },
      source_type: "tasks.created",
      source_id: task.id,
      created_at: times.taskCreated,
    });
    expect(normalizedEvent("tasks.completed", task.id)).toEqual({
      actor_type: "user",
      actor_id: actorId,
      event_type: "task_completed",
      payload: { task_id: task.id, to: "completed" },
      source_type: "tasks.completed",
      source_id: task.id,
      created_at: times.taskCompleted,
    });

    const booked = normalizedEvent("appointments.booked", mutationIds.booked);
    const bookedPayload = booked.payload as Record<string, unknown>;
    expect({ ...booked, payload: undefined }).toEqual({
      actor_type: "user",
      actor_id: actorId,
      event_type: "appointment_booked",
      payload: undefined,
      source_type: "appointments.booked",
      source_id: mutationIds.booked,
      created_at: times.appointmentBooked,
    });
    expect(Object.keys(bookedPayload).sort()).toEqual([
      "assignee_id",
      "due_at",
      "task_id",
    ]);
    expect(bookedPayload).toMatchObject({
      task_id: appointment.id,
      assignee_id: actorId,
    });
    expect(new Date(String(bookedPayload.due_at)).toISOString()).toBe(
      "2026-01-07T19:00:00.000Z",
    );
    expect(normalizedEvent("appointments.completed", appointment.id)).toEqual({
      actor_type: "user",
      actor_id: actorId,
      event_type: "appointment_held",
      payload: { task_id: appointment.id },
      source_type: "appointments.completed",
      source_id: appointment.id,
      created_at: times.appointmentHeld,
    });
    expect(normalizedEvent("appointments.completed", noShow.id)).toEqual({
      actor_type: "user",
      actor_id: actorId,
      event_type: "appointment_no_show",
      payload: { task_id: noShow.id },
      source_type: "appointments.completed",
      source_id: noShow.id,
      created_at: times.appointmentNoShow,
    });
    expect(
      normalizedEvent("appointments.canceled", mutationIds.canceled),
    ).toEqual({
      actor_type: "system",
      actor_id: null,
      event_type: "appointment_canceled",
      payload: { task_id: canceled.id },
      source_type: "appointments.canceled",
      source_id: mutationIds.canceled,
      created_at: times.appointmentCanceled,
    });
    const rescheduled = normalizedEvent(
      "appointments.rescheduled",
      mutationIds.rescheduled,
    );
    const rescheduledPayload = rescheduled.payload as Record<string, unknown>;
    expect({ ...rescheduled, payload: undefined }).toEqual({
      actor_type: "user",
      actor_id: actorId,
      event_type: "appointment_rescheduled",
      payload: undefined,
      source_type: "appointments.rescheduled",
      source_id: mutationIds.rescheduled,
      created_at: times.appointmentRescheduled,
    });
    expect(Object.keys(rescheduledPayload).sort()).toEqual([
      "from",
      "previous_task_id",
      "task_id",
      "to",
    ]);
    expect(rescheduledPayload).toMatchObject({
      task_id: rescheduleTarget.id,
      previous_task_id: rescheduleSource.id,
    });
    expect(new Date(String(rescheduledPayload.from)).toISOString()).toBe(
      "2026-01-07T20:30:00.000Z",
    );
    expect(new Date(String(rescheduledPayload.to)).toISOString()).toBe(
      "2026-01-09T20:30:00.000Z",
    );
    expect(
      normalizedEvent("appointments.reassigned", mutationIds.reassigned),
    ).toEqual({
      actor_type: "system",
      actor_id: null,
      event_type: "appointment_reassigned",
      payload: {
        task_id: appointment.id,
        from: actorId,
        to: ownerId,
      },
      source_type: "appointments.reassigned",
      source_id: mutationIds.reassigned,
      created_at: times.appointmentReassigned,
    });
    expect(
      normalizedEvent("consent_events.opt_out", consentIds.optedOut),
    ).toEqual({
      actor_type: "system",
      actor_id: null,
      event_type: "opted_out",
      payload: { channel: "sms", consent_type: "opt_out" },
      source_type: "consent_events.opt_out",
      source_id: consentIds.optedOut,
      created_at: times.optedOut,
    });
    expect(
      normalizedEvent("consent_events.consent_captured", consentIds.captured),
    ).toEqual({
      actor_type: "system",
      actor_id: null,
      event_type: "consent_captured",
      payload: {
        channel: "sms",
        consent_type: "opt_in_marketing_written",
      },
      source_type: "consent_events.consent_captured",
      source_id: consentIds.captured,
      created_at: times.consentCaptured,
    });
    expect(JSON.stringify(events)).not.toMatch(
      /Private task title|Private appointment|must not copy|Historical Ledger Ln/i,
    );

    const countBefore = events?.length;
    await runBackfill();
    const { count: countAfter } = await serviceClient
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("property_id", propertyId);
    expect(countAfter).toBe(countBefore);
  });

  it("does not duplicate genuinely live source-less qualification or task completion events", async () => {
    const propertyId = await insertProperty({
      address: "2 Live Event Guard Ln",
      createdAt: "2026-02-01T15:00:00.000Z",
      qualifiedAt: "2026-02-02T16:00:00.000Z",
      qualifiedBy: actorId,
    });
    const { data: task } = await serviceClient
      .from("tasks")
      .insert({
        org_id: BMH_ORG_ID,
        assignee_id: actorId,
        related_property_id: propertyId,
        type: "callback",
        status: "completed",
        title: "Live completion guard",
        due_at: "2026-02-03T17:00:00.000Z",
        completed_at: "2026-02-04T18:00:00.000Z",
        completed_by: actorId,
        created_by: actorId,
        created_at: "2026-02-03T16:00:00.000Z",
      })
      .select("id")
      .single();
    await serviceClient.from("lead_events").insert([
      {
        org_id: BMH_ORG_ID,
        property_id: propertyId,
        actor_type: "user",
        actor_id: actorId,
        event_type: "qualified",
        payload: { from: "prospect", to: "new_lead" },
        created_at: "2026-02-02T16:00:01.234Z",
      },
      {
        org_id: BMH_ORG_ID,
        property_id: propertyId,
        actor_type: "user",
        actor_id: actorId,
        event_type: "task_completed",
        payload: { task_id: task!.id, from: "open", to: "completed" },
        created_at: "2026-02-04T18:00:01.234Z",
      },
    ]);

    await runBackfill();

    const { data: qualified } = await serviceClient
      .from("lead_events")
      .select("source_type")
      .eq("property_id", propertyId)
      .eq("event_type", "qualified");
    const { data: completed } = await serviceClient
      .from("lead_events")
      .select("source_type")
      .eq("property_id", propertyId)
      .eq("event_type", "task_completed");
    expect(qualified).toEqual([{ source_type: null }]);
    expect(completed).toEqual([{ source_type: null }]);
  });

  it("falls back to system and skips consent without durable, temporally valid property provenance", async () => {
    const sharedContactId = await insertContact("Shared");
    const first = await insertProperty({
      address: "3 Ambiguous Consent Ln",
      createdAt: "2026-03-01T15:00:00.000Z",
      homeownerContactId: sharedContactId,
      qualifiedAt: "2026-03-02T16:00:00.000Z",
      qualifiedBy: crypto.randomUUID(),
    });
    const second = await insertProperty({
      address: "4 Ambiguous Consent Ln",
      createdAt: "2026-03-01T15:01:00.000Z",
      homeownerContactId: sharedContactId,
    });
    const otherContactId = await insertContact("Other");
    const otherContactProperty = await insertProperty({
      address: "5 Wrong Contact Consent Ln",
      createdAt: "2026-03-01T15:02:00.000Z",
      homeownerContactId: otherContactId,
    });
    const consentIds = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    const { error: consentError } = await serviceClient
      .from("consent_events")
      .insert([
        {
          id: consentIds[0],
          org_id: BMH_ORG_ID,
          contact_id: sharedContactId,
          channel: "sms",
          event_type: "provider_auto_opt_out",
          occurred_at: "2026-03-03T17:00:00.000Z",
        },
        {
          id: consentIds[1],
          org_id: BMH_ORG_ID,
          contact_id: sharedContactId,
          channel: "sms",
          event_type: "opt_out",
          source_detail: { propertyId: first },
          occurred_at: "2026-02-28T17:00:00.000Z",
        },
        {
          id: consentIds[2],
          org_id: BMH_ORG_ID,
          contact_id: sharedContactId,
          channel: "sms",
          event_type: "opt_out",
          source_detail: { propertyId: otherContactProperty },
          occurred_at: "2026-03-03T17:01:00.000Z",
        },
      ]);
    if (consentError) throw consentError;

    await runBackfill();

    const { data: qualification } = await serviceClient
      .from("lead_events")
      .select("actor_type, actor_id")
      .eq("property_id", first)
      .eq("event_type", "qualified")
      .single();
    expect(qualification).toEqual({ actor_type: "system", actor_id: null });
    const { count: consentCount } = await serviceClient
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .in("source_id", consentIds)
      .in("property_id", [first, second, otherContactProperty]);
    expect(consentCount).toBe(0);
  });
});
