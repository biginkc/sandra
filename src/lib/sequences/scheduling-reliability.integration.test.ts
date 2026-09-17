import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createTestClient } from "@tests/integration/client";
import {
  MOCK_SENDER_PRIMARY,
  seedSenderCatalog,
} from "@tests/integration/delivery";
import { getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import type { Database } from "@/lib/supabase/types";

import { runSequenceTick } from "@/app/api/cron/sequence-tick/handlers";
import * as messagingSend from "@/lib/messaging/send";
import {
  getMockMessageLog,
  resetMockState,
} from "@/lib/messaging/providers/mock";
import * as sequenceTick from "@/lib/sequences/tick";
import {
  enrollLead,
  resumeEnrollment,
  retrySequenceStep,
} from "@/lib/sequences/enrollment";

/**
 * These cases exercise the native sequence enrollment path through
 * `processEnrollmentTick`/`runSequenceTick`. They deliberately do not use
 * `queueOnly` or the scheduled-message drain contracts covered elsewhere.
 */

const supabase = createTestClient();
const realProcessEnrollmentTick = sequenceTick.processEnrollmentTick;

let T0 = new Date();
let safeState = "MO";

type SeededLead = {
  contactId: string;
  phone: string;
  propertyId: string;
};

type SequenceStep = {
  action?: "send_sms" | "change_status";
  body?: string;
  delay: number;
  targetStatus?: string;
  templateId?: string;
};

async function orgId(): Promise<string> {
  return getCanonicalTestOrgId(supabase);
}

function localHour(anchor: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone,
    })
      .format(anchor)
      .replace(/^24$/, "0"),
  );
}

function chooseState(anchor: Date, predicate: (hour: number) => boolean): string {
  const candidates: Array<[string, string]> = [
    ["GU", "Pacific/Guam"],
    ["PR", "America/Puerto_Rico"],
    ["OH", "America/New_York"],
    ["MO", "America/Chicago"],
    ["CA", "America/Los_Angeles"],
    ["HI", "Pacific/Honolulu"],
  ];
  const selected = candidates.find(([, zone]) => predicate(localHour(anchor, zone)));
  if (!selected) {
    throw new Error(`no test timezone matched DB anchor ${anchor.toISOString()}`);
  }
  return selected[0];
}

function chooseSendWindowState(anchor: Date): string {
  return chooseState(anchor, (hour) => hour >= 8 && hour < 21);
}

function chooseQuietState(anchor: Date): string {
  // +10 hours must reach the open window. Avoid 21:xx, where +10h would
  // still be 07:xx local and remain quiet.
  return chooseState(anchor, (hour) => hour >= 22 || hour <= 7);
}

/** Clear the sub-millisecond precision lost when a DB timestamp is read into Date. */
function setApplicationTimeAfterPersistedDue(nextRunAt: string): Date {
  const applicationDue = new Date(new Date(nextRunAt).getTime() + 1);
  vi.setSystemTime(applicationDue);
  return applicationDue;
}

async function seedSequence(
  name: string,
  steps: SequenceStep[],
  appendOptOut = false,
): Promise<{ id: string; stepIds: string[] }> {
  const { data: sequence, error: sequenceError } = await supabase
    .from("sequences")
    .insert({ org_id: await orgId(), name, append_opt_out: appendOptOut })
    .select("id")
    .single();
  if (sequenceError || !sequence) {
    throw new Error(`sequence seed failed: ${sequenceError?.message ?? "missing row"}`);
  }

  const stepIds: string[] = [];
  for (const [stepIndex, step] of steps.entries()) {
    const { data, error } = await supabase
      .from("sequence_steps")
      .insert({
        sequence_id: sequence.id,
        step_index: stepIndex,
        delay_after_previous_minutes: step.delay,
        action_type: step.action ?? "send_sms",
        target_status: step.targetStatus ?? null,
        template_id: step.templateId ?? null,
        template_body: step.templateId ? null : step.body ?? null,
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`step ${stepIndex} seed failed: ${error?.message ?? "missing row"}`);
    }
    stepIds.push(data.id);
  }
  return { id: sequence.id, stepIds };
}

async function seedLead(options: {
  address?: string;
  phone: string;
  seedInbound?: boolean;
  state?: string;
}): Promise<SeededLead> {
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      first_name: "Scheduling",
      last_name: "Reliability",
      phone_1: options.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact) {
    throw new Error(`contact seed failed: ${contactError?.message ?? "missing row"}`);
  }

  const { error: consentError } = await supabase.from("consent_events").insert({
    contact_id: contact.id,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "sequence-scheduling-reliability",
  });
  if (consentError) throw new Error(`consent seed failed: ${consentError.message}`);

  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .insert({
      address: options.address ?? "1 Scheduling Reliability Ln",
      state: options.state ?? safeState,
      status: "new_lead",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (propertyError || !property) {
    throw new Error(`property seed failed: ${propertyError?.message ?? "missing row"}`);
  }

  if (options.seedInbound !== false) {
    const { error: inboundError } = await supabase.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      property_id: property.id,
      contact_id: contact.id,
      from_address: options.phone,
      to_address: MOCK_SENDER_PRIMARY,
      body: "seed inbound business sender",
    });
    if (inboundError) throw new Error(`inbound seed failed: ${inboundError.message}`);
  }

  return { contactId: contact.id, phone: options.phone, propertyId: property.id };
}

async function enroll(sequenceId: string, propertyId: string): Promise<string> {
  const result = await enrollLead(supabase, { sequenceId, propertyId });
  if (result.status !== "enrolled") throw new Error(`enrollment failed: ${result.status}`);
  return result.enrollmentId;
}

async function loadEnrollment(enrollmentId: string) {
  const { data, error } = await supabase
    .from("sequence_enrollments")
    .select("id, status, current_step_index, next_run_at, pause_reason")
    .eq("id", enrollmentId)
    .single();
  if (error || !data) throw new Error(`enrollment read failed: ${error?.message ?? "missing row"}`);
  return data;
}

async function loadDueSnapshot(client: SupabaseClient<Database>, enrollmentId: string) {
  const { data, error } = await client
    .from("sequence_enrollments")
    .select(
      "id, org_id, sequence_id, property_id, contact_id, current_step_index, enrolled_by_user_id, status",
    )
    .eq("id", enrollmentId)
    .single();
  if (error || !data) {
    throw new Error(`scheduler snapshot failed: ${error?.message ?? "missing row"}`);
  }
  return data;
}

async function setDue(enrollmentId: string, at = T0): Promise<void> {
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({ next_run_at: at.toISOString() })
    .eq("id", enrollmentId);
  if (error) throw new Error(`due-time seed failed: ${error.message}`);
}

async function readStepRuns(enrollmentId: string) {
  const { data, error } = await supabase
    .from("sequence_step_runs")
    .select(
      "id, claim_active, attempt_outcome, attempt_started_at, run_at, message_id, skipped_reason, recovery_action, recovery_evidence",
    )
    .eq("enrollment_id", enrollmentId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`step-run read failed: ${error.message}`);
  return data ?? [];
}

/** Fault only the second native step lookup: the post-acceptance next-step SELECT. */
function clientWithNextStepSelectFailure(
  base: SupabaseClient<Database>,
): SupabaseClient<Database> {
  const client = Object.create(base) as SupabaseClient<Database>;
  const baseFrom = base.from.bind(base);
  let stepReads = 0;
  client.from = ((table: string) => {
    const builder = baseFrom(table as never) as unknown as Record<string, unknown>;
    if (table !== "sequence_steps") return builder as never;
    return new Proxy(builder, {
      get(target, property, receiver) {
        if (property === "maybeSingle") {
          return async (...args: unknown[]) => {
            stepReads += 1;
            if (stepReads === 2) {
              return { data: null, error: { message: "injected next-step SELECT failure" } };
            }
            return Reflect.apply(
              target[property] as (...values: unknown[]) => unknown,
              target,
              args,
            );
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as never;
  }) as SupabaseClient<Database>["from"];
  return client;
}

/** Fault only the terminal enrollment UPDATE after the provider has accepted. */
function clientWithCompletionUpdateFailure(
  base: SupabaseClient<Database>,
): SupabaseClient<Database> {
  const client = Object.create(base) as SupabaseClient<Database>;
  const baseFrom = base.from.bind(base);
  client.from = ((table: string) => {
    const builder = baseFrom(table as never) as unknown as Record<string, unknown>;
    if (table !== "sequence_enrollments") return builder as never;
    return new Proxy(builder, {
      get(target, property, receiver) {
        if (property !== "update") return Reflect.get(target, property, receiver);
        return (...args: unknown[]) => {
          const update = args[0];
          const next = Reflect.apply(
            target[property] as (...values: unknown[]) => Record<string, unknown>,
            target,
            args,
          );
          if (
            !update ||
            typeof update !== "object" ||
            (update as { status?: string }).status !== "completed"
          ) {
            return next;
          }
          return new Proxy(next, {
            get(updateTarget, updateProperty, updateReceiver) {
              if (updateProperty === "maybeSingle") {
                return async () => ({
                  data: null,
                  error: { message: "injected enrollment completion UPDATE failure" },
                });
              }
              return Reflect.get(updateTarget, updateProperty, updateReceiver);
            },
          });
        };
      },
    }) as never;
  }) as SupabaseClient<Database>["from"];
  return client;
}

/** Fault the sent-receipt UPDATE after the mock provider has accepted. */
function clientWithMessageReceiptUpdateFailure(
  base: SupabaseClient<Database>,
): SupabaseClient<Database> {
  const client = Object.create(base) as SupabaseClient<Database>;
  const baseFrom = base.from.bind(base);
  client.from = ((table: string) => {
    const builder = baseFrom(table as never) as unknown as Record<string, unknown>;
    if (table !== "messages") return builder as never;
    return new Proxy(builder, {
      get(target, property, receiver) {
        if (property !== "update") return Reflect.get(target, property, receiver);
        return (...args: unknown[]) => {
          const update = args[0];
          const next = Reflect.apply(
            target[property] as (...values: unknown[]) => Record<string, unknown>,
            target,
            args,
          );
          if (
            !update ||
            typeof update !== "object" ||
            (update as { status?: string }).status !== "sent"
          ) {
            return next;
          }
          return new Proxy(next, {
            get(updateTarget, updateProperty, updateReceiver) {
              if (updateProperty === "maybeSingle") {
                return async () => ({
                  data: null,
                  error: { message: "injected accepted receipt UPDATE failure" },
                });
              }
              return Reflect.get(updateTarget, updateProperty, updateReceiver);
            },
          });
        };
      },
    }) as never;
  }) as SupabaseClient<Database>["from"];
  return client;
}

async function seedClockAnchor(): Promise<Date> {
  const { data, error } = await supabase
    .from("sequences")
    .insert({
      org_id: await orgId(),
      name: "scheduling-reliability-db-clock-anchor",
      append_opt_out: false,
    })
    .select("created_at")
    .single();
  if (error || !data) {
    throw new Error(`clock anchor failed: ${error?.message ?? "missing row"}`);
  }
  return new Date(data.created_at);
}

beforeEach(async () => {
  await resetTenantTables(supabase);
  resetMockState();
  await seedSenderCatalog(supabase, await orgId(), [MOCK_SENDER_PRIMARY]);
  T0 = await seedClockAnchor();
  safeState = chooseSendWindowState(T0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native quiet-hours and explicit recovery", () => {
  it("defers quiet hours by exactly +10h, retains the released claim audit, and sends once after the window opens", async () => {
    const quietState = chooseQuietState(T0);
    const sequence = await seedSequence("quiet-hours-retained-claim", [
      { delay: 0, body: "quiet-hours recovery body" },
    ]);
    const lead = await seedLead({
      phone: "+18175552001",
      state: quietState,
    });
    const enrollmentId = await enroll(sequence.id, lead.propertyId);

    const blocked = await runSequenceTick(supabase);
    expect(blocked.processed).toBe(1);
    expect(blocked.outcomes.rescheduled_quiet_hours).toBe(1);
    expect(getMockMessageLog()).toHaveLength(0);

    const deferred = await loadEnrollment(enrollmentId);
    expect(deferred).toMatchObject({
      status: "active",
      current_step_index: 0,
    });
    expect(new Date(deferred.next_run_at!).getTime()).toBe(T0.getTime() + 10 * 60_000 * 60);

    const deferredRuns = await readStepRuns(enrollmentId);
    expect(deferredRuns).toHaveLength(1);
    expect(deferredRuns[0]).toMatchObject({
      claim_active: false,
      attempt_outcome: "not_attempted",
      message_id: null,
      skipped_reason: "quiet_hours",
      recovery_action: "quiet_hours_deferred",
      recovery_evidence: "provider was not authorized during quiet hours",
    });
    expect(deferredRuns[0].run_at).not.toBeNull();

    // The due timestamp comes from application Date.now, but the test reads
    // the persisted value before moving the fake application clock. This
    // keeps the DB and application clock domains explicit.
    vi.setSystemTime(new Date(deferred.next_run_at!));
    const released = await runSequenceTick(supabase);
    expect(released.outcomes.sent).toBe(1);
    expect(getMockMessageLog()).toHaveLength(1);
    expect(getMockMessageLog()[0].body).toContain("quiet-hours recovery body");

    const completed = await loadEnrollment(enrollmentId);
    expect(completed).toMatchObject({ status: "completed", next_run_at: null });
    const runsAfterRelease = await readStepRuns(enrollmentId);
    expect(runsAfterRelease).toHaveLength(2);
    expect(runsAfterRelease[0].claim_active).toBe(false);
    expect(runsAfterRelease[1]).toMatchObject({
      claim_active: true,
      attempt_outcome: "accepted",
    });
    expect(runsAfterRelease[1].run_at).not.toBeNull();

    const quietRepeat = await runSequenceTick(supabase);
    expect(quietRepeat.processed).toBe(0);
    expect(getMockMessageLog()).toHaveLength(1);
  });

  it("repairs a missing referenced template through resume and sends exactly once", async () => {
    const { data: template, error: templateError } = await supabase
      .from("sms_templates")
      .insert({
        org_id: await orgId(),
        name: "Scheduling missing template",
        content: "template before soft delete",
        category: "sequence-reliability",
      })
      .select("id")
      .single();
    if (templateError || !template) {
      throw new Error(`template seed failed: ${templateError?.message ?? "missing row"}`);
    }
    const sequence = await seedSequence("missing-template-recovery", [
      { delay: 0, templateId: template.id },
    ]);
    const lead = await seedLead({ phone: "+18175552002" });
    const enrollmentId = await enroll(sequence.id, lead.propertyId);

    const { error: deleteTemplateError } = await supabase
      .from("sms_templates")
      .update({ deleted_at: T0.toISOString() })
      .eq("id", template.id);
    expect(deleteTemplateError).toBeNull();

    const missing = await runSequenceTick(supabase);
    expect(missing.outcomes.paused).toBe(1);
    expect(getMockMessageLog()).toHaveLength(0);
    expect(await loadEnrollment(enrollmentId)).toMatchObject({
      status: "paused",
      pause_reason: "template_missing",
    });
    expect((await readStepRuns(enrollmentId))[0]).toMatchObject({
      claim_active: true,
      attempt_outcome: "not_attempted",
      run_at: expect.any(String),
      skipped_reason: "provider_failed",
    });

    const { error: repairError } = await supabase
      .from("sms_templates")
      .update({
        content: "repaired template body",
        deleted_at: null,
      })
      .eq("id", template.id);
    expect(repairError).toBeNull();
    expect((await resumeEnrollment(supabase, enrollmentId)).status).toBe("resumed");

    const repairedSchedule = await loadEnrollment(enrollmentId);
    expect(repairedSchedule.next_run_at).not.toBeNull();
    expect(new Date(repairedSchedule.next_run_at!).getTime()).toBeGreaterThanOrEqual(
      T0.getTime(),
    );
    setApplicationTimeAfterPersistedDue(repairedSchedule.next_run_at!);
    const repaired = await runSequenceTick(supabase);
    expect(repaired.outcomes.sent).toBe(1);
    expect(getMockMessageLog()).toHaveLength(1);
    expect(getMockMessageLog()[0].body).toContain("repaired template body");
    expect((await loadEnrollment(enrollmentId)).status).toBe("completed");

    const runs = await readStepRuns(enrollmentId);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      claim_active: false,
      attempt_outcome: "not_attempted",
      recovery_action: "resume",
    });
    expect(runs[1]).toMatchObject({ claim_active: true, attempt_outcome: "accepted" });
  });

  it("repairs missing sender inventory through resume and sends exactly once", async () => {
    const { error: clearSenderError } = await supabase
      .from("provider_sender_numbers")
      .delete()
      .eq("org_id", await orgId())
      .eq("provider", "mock");
    expect(clearSenderError).toBeNull();

    const sequence = await seedSequence("missing-sender-recovery", [
      { delay: 0, body: "repaired sender body" },
    ]);
    const lead = await seedLead({ phone: "+18175552003", seedInbound: false });
    const enrollmentId = await enroll(sequence.id, lead.propertyId);

    const missing = await runSequenceTick(supabase);
    expect(missing.outcomes.paused).toBe(1);
    expect(getMockMessageLog()).toHaveLength(0);
    expect(await loadEnrollment(enrollmentId)).toMatchObject({
      status: "paused",
      pause_reason: "no approved sender for first-touch sequence send",
    });
    expect((await readStepRuns(enrollmentId))[0]).toMatchObject({
      claim_active: true,
      attempt_outcome: "not_attempted",
      run_at: expect.any(String),
      skipped_reason: "provider_failed",
    });

    await seedSenderCatalog(supabase, await orgId(), [MOCK_SENDER_PRIMARY]);
    expect((await resumeEnrollment(supabase, enrollmentId)).status).toBe("resumed");
    const repairedSchedule = await loadEnrollment(enrollmentId);
    expect(repairedSchedule.next_run_at).not.toBeNull();
    setApplicationTimeAfterPersistedDue(repairedSchedule.next_run_at!);

    const repaired = await runSequenceTick(supabase);
    expect(repaired.outcomes.sent).toBe(1);
    expect(getMockMessageLog()).toHaveLength(1);
    expect(getMockMessageLog()[0].input.from).toBe(MOCK_SENDER_PRIMARY);
    expect((await loadEnrollment(enrollmentId)).status).toBe("completed");

    const runs = await readStepRuns(enrollmentId);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      claim_active: false,
      attempt_outcome: "not_attempted",
      recovery_action: "resume",
    });
    expect(runs[1]).toMatchObject({ claim_active: true, attempt_outcome: "accepted" });
  });

  it("holds a provider-off attempt, then resumes once after the provider is repaired", async () => {
    const sequence = await seedSequence("provider-off-recovery", [
      { delay: 0, body: "provider repair body" },
    ]);
    const lead = await seedLead({ phone: "+18175552007" });
    const enrollmentId = await enroll(sequence.id, lead.propertyId);

    const providerOff = vi
      .spyOn(messagingSend, "sendSmsToContact")
      .mockResolvedValueOnce({
        status: "blocked_provider_off",
        reason: "injected provider-off boundary",
      });
    const blocked = await runSequenceTick(supabase);
    providerOff.mockRestore();

    expect(blocked.outcomes.paused).toBe(1);
    expect(getMockMessageLog()).toHaveLength(0);
    expect(await loadEnrollment(enrollmentId)).toMatchObject({
      status: "paused",
      pause_reason: "provider_failed",
    });
    expect((await readStepRuns(enrollmentId))[0]).toMatchObject({
      claim_active: true,
      attempt_outcome: "not_attempted",
      skipped_reason: "provider_failed",
    });

    expect((await resumeEnrollment(supabase, enrollmentId)).status).toBe("resumed");
    const repairedSchedule = await loadEnrollment(enrollmentId);
    expect(repairedSchedule.next_run_at).not.toBeNull();
    setApplicationTimeAfterPersistedDue(repairedSchedule.next_run_at!);
    const repaired = await runSequenceTick(supabase);
    expect(repaired.outcomes.sent).toBe(1);
    expect(getMockMessageLog()).toHaveLength(1);
    expect((await loadEnrollment(enrollmentId)).status).toBe("completed");
    expect((await readStepRuns(enrollmentId)).filter((run) => run.attempt_outcome === "accepted"))
      .toHaveLength(1);
  });
});

describe("native quiet-hours boundary characterization", () => {
  it("allows an exact 08:00 local send across the fall DST boundary", async () => {
    const sequence = await seedSequence("quiet-dst-open-boundary", [
      { delay: 0, body: "DST boundary body" },
    ]);
    const lead = await seedLead({ phone: "+18175552010", state: "MO" });
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const snapshot = await loadDueSnapshot(supabase, enrollmentId);

    // 14:00 UTC is exactly 08:00 CST after the 2026 fall-back transition.
    vi.setSystemTime(new Date("2026-11-01T14:00:00.000Z"));
    const outcome = await sequenceTick.processEnrollmentTick(supabase, snapshot);
    expect(outcome.status).toBe("sent");
    expect(getMockMessageLog()).toHaveLength(1);
    expect((await loadEnrollment(enrollmentId)).status).toBe("completed");
  });

  it("fails closed for an unknown state and leaves the provider untouched", async () => {
    const sequence = await seedSequence("quiet-unknown-state", [
      { delay: 0, body: "unknown-state body" },
    ]);
    const lead = await seedLead({ phone: "+18175552011", state: "ZZ" });
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const snapshot = await loadDueSnapshot(supabase, enrollmentId);

    const outcome = await sequenceTick.processEnrollmentTick(supabase, snapshot);
    expect(outcome.status).toBe("rescheduled_quiet_hours");
    expect(getMockMessageLog()).toHaveLength(0);
    const enrollment = await loadEnrollment(enrollmentId);
    expect(enrollment).toMatchObject({ status: "active", current_step_index: 0 });
    expect(new Date(enrollment.next_run_at!).getTime()).toBe(T0.getTime() + 10 * 60 * 60 * 1000);
    expect((await readStepRuns(enrollmentId))[0]).toMatchObject({
      claim_active: false,
      attempt_outcome: "not_attempted",
      skipped_reason: "quiet_hours",
    });
  });
});

describe("native scheduler fairness and isolation", () => {
  it("uses a mid-flight step edit and allows two sequences on one handset to complete independently", async () => {
    const firstSequence = await seedSequence("same-handset-first-sequence", [
      { delay: 0, body: "first sequence body" },
    ]);
    const secondSequence = await seedSequence("same-handset-second-sequence", [
      { delay: 0, body: "second sequence body before edit" },
    ]);
    const lead = await seedLead({ phone: "+18175552009" });
    const firstEnrollmentId = await enroll(firstSequence.id, lead.propertyId);
    const secondEnrollmentId = await enroll(secondSequence.id, lead.propertyId);
    const firstSnapshot = await loadDueSnapshot(supabase, firstEnrollmentId);
    const secondSnapshot = await loadDueSnapshot(supabase, secondEnrollmentId);

    const { error: editError } = await supabase
      .from("sequence_steps")
      .update({ template_body: "second sequence body after mid-flight edit" })
      .eq("id", secondSequence.stepIds[0]);
    expect(editError).toBeNull();

    const first = await sequenceTick.processEnrollmentTick(supabase, firstSnapshot);
    const second = await sequenceTick.processEnrollmentTick(supabase, secondSnapshot);
    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    expect(getMockMessageLog()).toHaveLength(2);
    expect(getMockMessageLog().map((entry) => entry.body)).toEqual(
      expect.arrayContaining([
        "first sequence body",
        "second sequence body after mid-flight edit",
      ]),
    );
    expect((await loadEnrollment(firstEnrollmentId)).status).toBe("completed");
    expect((await loadEnrollment(secondEnrollmentId)).status).toBe("completed");
  });

  it("does not let 100 retained due claims starve the 101st independent enrollment", async () => {
    const sequence = await seedSequence("retained-head-fairness", [
      { delay: 0, body: "fairness control body" },
    ]);
    const org = await orgId();
    const populationSize = 101;
    const contactsToInsert = Array.from({ length: populationSize }, (_, index) => ({
      first_name: "Fairness",
      last_name: `Lead ${index}`,
      phone_1: `+181655${String(30000 + index).padStart(5, "0")}`,
      phone_1_type: "mobile",
    }));
    const { data: contacts, error: contactsError } = await supabase
      .from("contacts")
      .insert(contactsToInsert)
      .select("id, phone_1");
    if (contactsError || !contacts || contacts.length !== populationSize) {
      throw new Error(`fairness contacts failed: ${contactsError?.message ?? contacts?.length}`);
    }
    const contactByPhone = new Map(contacts.map((contact) => [contact.phone_1, contact.id]));
    const propertiesToInsert = contactsToInsert.map((contact, index) => ({
      address: `${index} Fairness Ln`,
      state: safeState,
      status: "new_lead",
      homeowner_contact_id: contactByPhone.get(contact.phone_1)!,
    }));
    const { data: properties, error: propertiesError } = await supabase
      .from("properties")
      .insert(propertiesToInsert)
      .select("id, homeowner_contact_id");
    if (propertiesError || !properties || properties.length !== populationSize) {
      throw new Error(`fairness properties failed: ${propertiesError?.message ?? properties?.length}`);
    }
    const propertyByContact = new Map(
      properties.map((property) => [property.homeowner_contact_id, property.id]),
    );
    const { error: consentError } = await supabase.from("consent_events").insert(
      contacts.map((contact) => ({
        contact_id: contact.id,
        channel: "sms",
        event_type: "opt_in_marketing_written",
        source: "sequence-scheduling-fairness",
      })),
    );
    expect(consentError).toBeNull();
    const { error: inboundError } = await supabase.from("messages").insert(
      contacts.map((contact) => ({
        channel: "sms",
        direction: "inbound",
        status: "received",
        property_id: propertyByContact.get(contact.id)!,
        contact_id: contact.id,
        from_address: contact.phone_1,
        to_address: MOCK_SENDER_PRIMARY,
        body: "fairness sender seed",
      })),
    );
    expect(inboundError).toBeNull();

    const dueAt = new Date(T0.getTime() - 60_000).toISOString();
    const enrollmentRows = contacts.map((contact) => ({
      org_id: org,
      sequence_id: sequence.id,
      property_id: propertyByContact.get(contact.id)!,
      contact_id: contact.id,
      status: "active",
      current_step_index: 0,
      next_run_at: dueAt,
    }));
    const { data: enrollments, error: enrollmentError } = await supabase
      .from("sequence_enrollments")
      .insert(enrollmentRows)
      .select("id, contact_id")
      .order("id");
    if (enrollmentError || !enrollments || enrollments.length !== populationSize) {
      throw new Error(`fairness enrollments failed: ${enrollmentError?.message ?? enrollments?.length}`);
    }
    const headEnrollments = enrollments.slice(0, populationSize - 1);
    const { error: headClaimError } = await supabase.from("sequence_step_runs").insert(
      headEnrollments.map((enrollment) => ({
        enrollment_id: enrollment.id,
        step_id: sequence.stepIds[0],
        scheduled_for: dueAt,
        claim_active: true,
        attempt_outcome: "unknown",
        attempt_started_at: T0.toISOString(),
        run_at: null,
      })),
    );
    expect(headClaimError).toBeNull();
    const independent = enrollments[populationSize - 1];
    const { error: independentDueError } = await supabase
      .from("sequence_enrollments")
      .update({ next_run_at: T0.toISOString() })
      .eq("id", independent.id);
    expect(independentDueError).toBeNull();

    // The first 100 rows are deliberately older in scheduler order. They
    // remain live claims, so a tick must inspect them without letting the
    // batch boundary permanently hide the independent 101st row.
    const firstTick = await runSequenceTick(supabase);
    expect(firstTick.processed).toBeGreaterThanOrEqual(100);
    expect(firstTick.processed).toBeLessThanOrEqual(101);
    expect(getMockMessageLog().length).toBeLessThanOrEqual(1);
    const secondTick = await runSequenceTick(supabase);
    expect(firstTick.processed + secondTick.processed).toBeGreaterThanOrEqual(101);
    expect(getMockMessageLog()).toHaveLength(1);

    const { data: independentEnrollment, error: independentError } = await supabase
      .from("sequence_enrollments")
      .select("status, current_step_index, next_run_at")
      .eq("id", independent.id)
      .single();
    expect(independentError).toBeNull();
    expect(independentEnrollment).toMatchObject({
      status: "completed",
      current_step_index: 0,
      next_run_at: null,
    });
  });

  it("isolates one thrown enrollment and still processes independent due work", async () => {
    const sequence = await seedSequence("thrown-enrollment-isolation", [
      { delay: 0, body: "independent due body" },
    ]);
    const thrownLead = await seedLead({ phone: "+18175552004" });
    const independentLead = await seedLead({ phone: "+18175552005" });
    const thrownEnrollmentId = await enroll(sequence.id, thrownLead.propertyId);
    const independentEnrollmentId = await enroll(sequence.id, independentLead.propertyId);
    await setDue(thrownEnrollmentId, new Date(T0.getTime() - 60_000));
    await setDue(independentEnrollmentId, T0);

    let calls = 0;
    const processSpy = vi
      .spyOn(sequenceTick, "processEnrollmentTick")
      .mockImplementation(async (client, enrollment) => {
        calls += 1;
        if (calls === 1) throw new Error("simulated enrollment worker throw");
        return realProcessEnrollmentTick(client, enrollment);
      });
    const summary = await runSequenceTick(supabase);
    processSpy.mockRestore();

    expect(summary.processed).toBe(2);
    expect(summary.outcomes.failed).toBe(1);
    expect(summary.outcomes.sent).toBe(1);
    expect(getMockMessageLog()).toHaveLength(1);
    expect((await loadEnrollment(thrownEnrollmentId)).status).toBe("active");
    expect((await loadEnrollment(independentEnrollmentId)).status).toBe("completed");
  });
});

describe("native accepted-message persistence recovery", () => {
  it("keeps an accepted provider attempt reconciliable when message receipt persistence returns a DB error", async () => {
    const sequence = await seedSequence("accepted-message-persistence-failure", [
      { delay: 0, body: "accepted persistence failure body" },
    ]);
    const lead = await seedLead({ phone: "+18175552006" });
    const enrollmentId = await enroll(sequence.id, lead.propertyId);

    const first = await runSequenceTick(clientWithMessageReceiptUpdateFailure(supabase));

    expect(first.outcomes.failed).toBe(1);
    expect(getMockMessageLog()).toHaveLength(1);
    expect(await loadEnrollment(enrollmentId)).toMatchObject({
      status: "paused",
      pause_reason: "reconciliation_required",
    });
    const runs = await readStepRuns(enrollmentId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      claim_active: true,
      attempt_outcome: "accepted",
      message_id: expect.any(String),
      run_at: expect.any(String),
    });

    const { data: message, error: messageError } = await supabase
      .from("messages")
      .select("id, status, external_id")
      .eq("id", runs[0].message_id!)
      .single();
    expect(messageError).toBeNull();
    expect(message).toMatchObject({
      id: runs[0].message_id,
      status: "pending",
      external_id: null,
    });

    expect((await resumeEnrollment(supabase, enrollmentId)).status).toBe(
      "reconciliation_required",
    );
    const retry = await retrySequenceStep(supabase, enrollmentId);
    expect(retry).toMatchObject({ status: "reconciliation_required" });
    const later = await runSequenceTick(supabase);
    expect(later.processed).toBe(0);
    expect(getMockMessageLog()).toHaveLength(1);
  });
});

describe("native accepted-send post-provider database faults", () => {
  it.each([
    ["next-step SELECT", clientWithNextStepSelectFailure],
    ["enrollment completion UPDATE", clientWithCompletionUpdateFailure],
  ] as const)(
    "retains an accepted claim when the %s fails",
    async (_faultName, makeFaultClient) => {
      const sequence = await seedSequence(`accepted-post-provider-${_faultName}`, [
        { delay: 0, body: "accepted post-provider fault body" },
      ]);
      const lead = await seedLead({ phone: "+18175552008" });
      const enrollmentId = await enroll(sequence.id, lead.propertyId);

      const first = await runSequenceTick(makeFaultClient(supabase));
      expect(first.outcomes.failed).toBe(1);
      expect(getMockMessageLog()).toHaveLength(1);
      expect(await loadEnrollment(enrollmentId)).toMatchObject({
        status: "paused",
        pause_reason: "reconciliation_required",
      });

      const runs = await readStepRuns(enrollmentId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        claim_active: true,
        attempt_outcome: "accepted",
        message_id: expect.any(String),
        run_at: expect.any(String),
      });
      const { data: persistedMessage, error: messageError } = await supabase
        .from("messages")
        .select("id, status, external_id")
        .eq("id", runs[0].message_id!)
        .single();
      expect(messageError).toBeNull();
      expect(persistedMessage).toMatchObject({
        id: runs[0].message_id,
        status: "sent",
        external_id: expect.any(String),
      });

      expect((await resumeEnrollment(supabase, enrollmentId)).status).toBe(
        "reconciliation_required",
      );
      expect((await retrySequenceStep(supabase, enrollmentId)).status).toBe(
        "reconciliation_required",
      );
      expect((await runSequenceTick(supabase)).processed).toBe(0);
      expect(getMockMessageLog()).toHaveLength(1);
    },
  );
});
