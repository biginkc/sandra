import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import { createTestClient } from "@tests/integration/client";
import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import {
  clientForUser,
  createOrgUser,
  getCanonicalTestOrgId,
  seedTwoOrgs,
  TEST_ORG_B_ID,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import { selectSafeApplicationClock } from "@tests/sequence-readiness/clock";

import { handleInboundWebhook } from "@/lib/messaging/inbound";
import { MockMessagingProvider, resetMockState, getMockMessageLog } from "@/lib/messaging/providers/mock";
import { runSequenceTick } from "@/app/api/cron/sequence-tick/handlers";
import { enrollLead, pausePropertyEnrollments, resumeByProperty } from "./enrollment";
import { processEnrollmentTick } from "./tick";
import type { Database } from "@/lib/supabase/types";

const supabase = createTestClient();
let testNow = new Date();
let applicationNow = new Date();
let safeState = "GU";

async function orgId(): Promise<string> {
  return getCanonicalTestOrgId(supabase);
}

async function seedSequence(name: string): Promise<{ id: string; stepId: string }> {
  const { data: sequence, error: sequenceError } = await supabase
    .from("sequences")
    .insert({ org_id: await orgId(), name, append_opt_out: false })
    .select("id")
    .single();
  if (sequenceError || !sequence) throw new Error(sequenceError?.message ?? "sequence seed failed");

  const { data: step, error: stepError } = await supabase
    .from("sequence_steps")
    .insert({
      sequence_id: sequence.id,
      step_index: 0,
      delay_after_previous_minutes: 0,
      action_type: "send_sms",
      template_body: "recovery security test",
    })
    .select("id")
    .single();
  if (stepError || !step) throw new Error(stepError?.message ?? "step seed failed");
  return { id: sequence.id, stepId: step.id };
}

async function seedLead(
  phone: string,
  options: { phone1?: string; phone2?: string } = {},
): Promise<{ propertyId: string; contactId: string }> {
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      first_name: "Recovery",
      last_name: "Security",
      phone_1: options.phone1 ?? phone,
      phone_1_type: "mobile",
      ...(options.phone2
        ? { phone_2: options.phone2, phone_2_type: "mobile" }
        : {}),
    })
    .select("id")
    .single();
  if (contactError || !contact) throw new Error(contactError?.message ?? "contact seed failed");
  const { error: consentError } = await supabase.from("consent_events").insert({
    contact_id: contact.id,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "sequence-recovery-security-test",
  });
  if (consentError) throw new Error(consentError.message);

  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .insert({
      address: "1 Recovery Security Ln",
      state: safeState,
      status: "new_lead",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (propertyError || !property) throw new Error(propertyError?.message ?? "property seed failed");

  const { error: inboundError } = await supabase.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    property_id: property.id,
    contact_id: contact.id,
    from_address: phone,
    to_address: MOCK_SENDER_PRIMARY,
    body: "sender fixture",
  });
  if (inboundError) throw new Error(inboundError.message);
  return { propertyId: property.id, contactId: contact.id };
}

async function enroll(sequenceId: string, propertyId: string): Promise<string> {
  const result = await enrollLead(supabase, { sequenceId, propertyId });
  if (result.status !== "enrolled") throw new Error("enrollment failed: " + result.status);
  return result.enrollmentId;
}

async function snapshot(enrollmentId: string) {
  const { data, error } = await supabase
    .from("sequence_enrollments")
    .select("id, org_id, sequence_id, property_id, contact_id, current_step_index, enrolled_by_user_id, status")
    .eq("id", enrollmentId)
    .single();
  if (error || !data) throw new Error(error?.message ?? "snapshot failed");
  return data;
}

async function seedClaim(
  enrollmentId: string,
  stepId: string,
  outcome: "not_attempted" | "definitively_rejected" = "definitively_rejected",
) {
  const { data, error } = await supabase
    .from("sequence_step_runs")
    .insert({
      enrollment_id: enrollmentId,
      step_id: stepId,
      scheduled_for: testNow.toISOString(),
      run_at: outcome === "definitively_rejected" ? testNow.toISOString() : null,
      skipped_reason: outcome === "definitively_rejected" ? "provider_failed" : null,
      attempt_outcome: outcome,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "claim seed failed");
  return data.id;
}

async function pauseEnrollment(
  enrollmentId: string,
  reason: "provider_failed" | "call_in_progress",
) {
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({ status: "paused", pause_reason: reason, next_run_at: testNow.toISOString() })
    .eq("id", enrollmentId);
  if (error) throw new Error(error.message);
}

function clientPausesAfterClaim(
  base: SupabaseClient<Database>,
  pauseClient: SupabaseClient<Database>,
  propertyId: string,
): SupabaseClient<Database> {
  const wrapped = Object.create(base) as SupabaseClient<Database>;
  const baseFrom = base.from.bind(base);
  const wrapClaimBuilder = (builder: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(builder, {
      get(target, property, receiver) {
        if (property === "select") {
          return (...args: unknown[]) =>
            wrapClaimBuilder(
              Reflect.apply(
                target[property] as (...values: unknown[]) => Record<string, unknown>,
                target,
                args,
              ),
            );
        }
        if (property === "insert") {
          return (...args: unknown[]) =>
            wrapClaimBuilder(
              Reflect.apply(
                target[property] as (...values: unknown[]) => Record<string, unknown>,
                target,
                args,
              ),
            );
        }
        if (property === "single") {
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(
              target[property] as (...values: unknown[]) => unknown,
              target,
              args,
            );
            const paused = await pausePropertyEnrollments(pauseClient, {
              propertyId,
              reason: "call_in_progress",
            });
            if (paused.paused !== 1) throw new Error("call pause did not win after claim");
            return result;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

  wrapped.from = ((table: string) => {
    const builder = baseFrom(table as never) as unknown as Record<string, unknown>;
    return table === "sequence_step_runs"
      ? (wrapClaimBuilder(builder) as never)
      : (builder as never);
  }) as SupabaseClient<Database>["from"];
  return wrapped;
}

beforeEach(async () => {
  await resetTenantTables(supabase);
  resetMockState();
  await seedTwoOrgs(supabase);
  await seedSenderCatalog(supabase, await orgId(), [MOCK_SENDER_PRIMARY]);
  const { data: anchor, error } = await supabase
    .from("sequences")
    .insert({ org_id: await orgId(), name: "recovery-security-clock", append_opt_out: false })
    .select("created_at")
    .single();
  if (error || !anchor) throw new Error(error?.message ?? "clock anchor failed");
  testNow = new Date(anchor.created_at);
  const applicationClock = selectSafeApplicationClock(testNow, 30);
  applicationNow = applicationClock.applicationNow;
  safeState = applicationClock.state;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(applicationNow);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sequence recovery security", () => {
  it("retires a claim when a call pause wins after claim and resumes without sending", async () => {
    const sequence = await seedSequence("call-pause-after-claim");
    const lead = await seedLead("+18175552001");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);

    const outcome = await processEnrollmentTick(
      clientPausesAfterClaim(createTestClient(), createTestClient(), lead.propertyId),
      await snapshot(enrollmentId),
    );
    expect(outcome.status).toBe("paused");
    // The send path may leave a failed outbound breadcrumb after the final
    // sequence authorization rejects a paused enrollment. That row is not a
    // provider invocation; the claim outcome and provider log are the durable
    // no-send evidence this recovery test needs.
    expect(getMockMessageLog()).toHaveLength(0);
    const { data: outbound } = await supabase
      .from("messages")
      .select("id, status, external_id")
      .eq("property_id", lead.propertyId)
      .eq("direction", "outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound?.[0]).toMatchObject({ status: "failed", external_id: null });
    const { data: claimBeforeResume } = await supabase
      .from("sequence_step_runs")
      .select("claim_active, attempt_outcome, run_at, skipped_reason")
      .eq("enrollment_id", enrollmentId)
      .single();
    expect(claimBeforeResume).toMatchObject({
      claim_active: true,
      attempt_outcome: "definitively_rejected",
      skipped_reason: "provider_failed",
    });
    expect(claimBeforeResume?.run_at).toEqual(expect.any(String));

    const resumed = await resumeByProperty(supabase, { propertyId: lead.propertyId });
    expect(resumed.resumed).toBe(1);
    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("status, pause_reason")
      .eq("id", enrollmentId)
      .single();
    expect(enrollment).toEqual({ status: "active", pause_reason: null });

    const { data: claims } = await supabase
      .from("sequence_step_runs")
      .select("claim_active, attempt_outcome, recovery_action, recovery_evidence")
      .eq("enrollment_id", enrollmentId);
    expect(claims).toHaveLength(1);
    expect(claims?.[0]).toMatchObject({
      claim_active: false,
      attempt_outcome: "definitively_rejected",
      recovery_action: "resume",
    });
    expect(claims?.[0].recovery_evidence).toContain("proven no-attempt");
  });

  it("makes a permanent STOP terminal even when the enrollment is already paused", async () => {
    const sequence = await seedSequence("paused-stop");
    const lead = await seedLead("+18175552002");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    await pausePropertyEnrollments(supabase, {
      propertyId: lead.propertyId,
      reason: "call_in_progress",
    });

    const stopped = await pausePropertyEnrollments(supabase, {
      propertyId: lead.propertyId,
      reason: "consent_revoked",
      permanent: true,
    });
    expect(stopped.paused).toBe(1);
    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("status, pause_reason, next_run_at")
      .eq("id", enrollmentId)
      .single();
    expect(enrollment).toEqual({
      status: "opted_out",
      pause_reason: "consent_revoked",
      next_run_at: null,
    });
  });

  it.each([
    ["STOP", "STOP"],
    ["STOPALL", "STOPALL"],
    ["UNSUBSCRIBE", "UNSUBSCRIBE"],
    ["END", "END"],
    ["CANCEL", "CANCEL"],
    ["QUIT", "QUIT"],
    ["REMOVE", "REMOVE"],
    ["mixed-case whitespace", "  sToP  "],
  ] as const)(
    "applies supported STOP keyword %s once across same-phone contacts and ignores its replay",
    async (_label, keyword) => {
      const stoppedSequence = await seedSequence("stop-same-phone");
      const controlSequence = await seedSequence("stop-control");
      const stoppedLead = await seedLead("+18175553001");
      const samePhoneLead = await seedLead("+18175553001", {
        // phone_1 is globally unique; exercise the supported cross-slot
        // handset shape by storing the shared number in phone_2.
        phone1: "+18175553011",
        phone2: "+18175553001",
      });
      const controlLead = await seedLead("+18175553002");
      const stoppedEnrollment = await enroll(stoppedSequence.id, stoppedLead.propertyId);
      const samePhoneEnrollment = await enroll(stoppedSequence.id, samePhoneLead.propertyId);
      const controlEnrollment = await enroll(controlSequence.id, controlLead.propertyId);

      const prePaused = await pausePropertyEnrollments(supabase, {
        propertyId: stoppedLead.propertyId,
        reason: "call_in_progress",
      });
      expect(prePaused.paused).toBe(1);

      const externalId = `stop-replay-${randomUUID()}`;
      const request = () =>
        new Request("https://example.test/webhooks/mock", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mock-signature": "valid",
          },
          body: JSON.stringify({
            externalId,
            from: "+18175553001",
            to: MOCK_SENDER_PRIMARY,
            body: keyword,
          }),
        });
      const provider = new MockMessagingProvider();
      const firstStop = await handleInboundWebhook(request(), {
        includeFullUrl: false,
        provider,
      });
      const replayStop = await handleInboundWebhook(request(), {
        includeFullUrl: false,
        provider,
      });
      expect(firstStop.status).toBe(200);
      expect(replayStop.status).toBe(200);

      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, sms_opted_out")
        .in("id", [stoppedLead.contactId, samePhoneLead.contactId]);
      expect(contacts).toHaveLength(2);
      expect(contacts?.every((contact) => contact.sms_opted_out)).toBe(true);
      const { count: optOutEvents } = await supabase
        .from("consent_events")
        .select("id", { count: "exact", head: true })
        .in("contact_id", [stoppedLead.contactId, samePhoneLead.contactId])
        .eq("event_type", "opt_out");
      expect(optOutEvents).toBe(2);

      const { data: stoppedRows } = await supabase
        .from("sequence_enrollments")
        .select("id, status, pause_reason, next_run_at")
        .in("id", [stoppedEnrollment, samePhoneEnrollment]);
      expect(stoppedRows).toHaveLength(2);
      expect(stoppedRows?.every((row) =>
        row.status === "opted_out" &&
        row.pause_reason === "consent_revoked" &&
        row.next_run_at === null,
      )).toBe(true);

      vi.setSystemTime(new Date(applicationNow.getTime() + 5 * 60_000));
      const firstTick = await runSequenceTick(supabase);
      vi.setSystemTime(new Date(applicationNow.getTime() + 15 * 60_000));
      const secondTick = await runSequenceTick(supabase);
      expect(firstTick.outcomes.sent).toBe(1);
      expect(secondTick.processed).toBe(0);
      expect((await supabase
        .from("sequence_enrollments")
        .select("status")
        .eq("id", controlEnrollment)
        .single()).data?.status).toBe("completed");
      expect(getMockMessageLog()).toHaveLength(1);
      expect(getMockMessageLog()[0]?.to).toBe("+18175553002");
      expect(getMockMessageLog().some((entry) => entry.to === "+18175553001")).toBe(false);
  });

  it("rolls back retry and resume claim retirement when a DNC audit trigger rejects the write", async () => {
    const sequence = await seedSequence("dnc-rollback");
    const firstLead = await seedLead("+18175552003");
    const firstEnrollment = await enroll(sequence.id, firstLead.propertyId);
    const firstClaim = await seedClaim(firstEnrollment, sequence.stepId);
    await pauseEnrollment(firstEnrollment, "provider_failed");
    await supabase.from("properties").update({ is_dnc_locked: true }).eq("id", firstLead.propertyId);

    const retry = await supabase.rpc("retry_sequence_step", {
      p_enrollment_id: firstEnrollment,
      p_actor_user_id: null,
    });
    expect(retry.error).toBeTruthy();
    const { data: retryClaim } = await supabase
      .from("sequence_step_runs")
      .select("claim_active, recovery_action")
      .eq("id", firstClaim)
      .single();
    expect(retryClaim).toEqual({ claim_active: true, recovery_action: null });

    const secondLead = await seedLead("+18175552004");
    const secondEnrollment = await enroll(sequence.id, secondLead.propertyId);
    const secondClaim = await seedClaim(secondEnrollment, sequence.stepId);
    await pauseEnrollment(secondEnrollment, "call_in_progress");
    await supabase.from("properties").update({ is_dnc_locked: true }).eq("id", secondLead.propertyId);
    const resume = await supabase.rpc("resume_sequence_enrollment", {
      p_enrollment_id: secondEnrollment,
      p_actor_user_id: null,
    });
    expect(resume.error).toBeTruthy();
    const { data: resumeClaim } = await supabase
      .from("sequence_step_runs")
      .select("claim_active, recovery_action")
      .eq("id", secondClaim)
      .single();
    expect(resumeClaim).toEqual({ claim_active: true, recovery_action: null });
  });

  it("returns one reconciliation result for a stale ambiguous claim", async () => {
    const sequence = await seedSequence("stale-unknown-single-result");
    const lead = await seedLead("+18175553003");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const staleAt = new Date(testNow.getTime() - 30 * 60_000).toISOString();
    const { data: claim, error: claimError } = await supabase
      .from("sequence_step_runs")
      .insert({
        enrollment_id: enrollmentId,
        step_id: sequence.stepId,
        scheduled_for: staleAt,
        created_at: staleAt,
        attempt_started_at: staleAt,
        attempt_outcome: "unknown",
        claim_active: true,
        run_at: null,
      })
      .select("id")
      .single();
    if (claimError || !claim) throw new Error(claimError?.message ?? "stale claim seed failed");

    const stale = await supabase.rpc("retire_stale_sequence_claim", {
      p_enrollment_id: enrollmentId,
      p_step_id: sequence.stepId,
      p_claim_id: claim.id,
      p_stale_before: staleAt,
    });
    expect(stale.error).toBeNull();
    expect(stale.data).toEqual([{ outcome: "reconciliation_required" }]);
    const { data: row } = await supabase
      .from("sequence_enrollments")
      .select("status, pause_reason")
      .eq("id", enrollmentId)
      .single();
    expect(row).toEqual({ status: "paused", pause_reason: "reconciliation_required" });
  });

  it("uses opt-out as the winner when consent events share a timestamp", async () => {
    const sequence = await seedSequence("tied-consent-opt-out");
    const lead = await seedLead("+18175553004");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const tiedAt = new Date(testNow.getTime() + 60_000).toISOString();
    const { error: consentError } = await supabase.from("consent_events").insert([
      {
        contact_id: lead.contactId,
        channel: "sms",
        event_type: "opt_in_marketing_written",
        source: "tied-consent-test",
        occurred_at: tiedAt,
      },
      {
        contact_id: lead.contactId,
        channel: "sms",
        event_type: "opt_out",
        source: "tied-consent-test",
        occurred_at: tiedAt,
      },
    ]);
    if (consentError) throw new Error(consentError.message);

    const { data: claim, error: claimError } = await supabase
      .from("sequence_step_runs")
      .insert({
        enrollment_id: enrollmentId,
        step_id: sequence.stepId,
        scheduled_for: testNow.toISOString(),
        attempt_outcome: "not_attempted",
        claim_active: true,
      })
      .select("id")
      .single();
    if (claimError || !claim) throw new Error(claimError?.message ?? "consent claim seed failed");
    const { data: message, error: messageError } = await supabase
      .from("messages")
      .insert({
        channel: "sms",
        direction: "outbound",
        status: "pending",
        property_id: lead.propertyId,
        contact_id: lead.contactId,
        from_address: MOCK_SENDER_PRIMARY,
        to_address: "+18175553004",
        body: "tied consent authorization",
      })
      .select("id")
      .single();
    if (messageError || !message) throw new Error(messageError?.message ?? "message seed failed");

    const authorization = await supabase.rpc("authorize_sequence_provider_attempt", {
      p_enrollment_id: enrollmentId,
      p_step_id: sequence.stepId,
      p_claim_id: claim.id,
      p_contact_id: lead.contactId,
      p_property_id: lead.propertyId,
      p_phone: "+18175553004",
      p_message_id: message.id,
    });
    expect(authorization.error).toBeNull();
    expect(authorization.data).toEqual([
      {
        authorized: false,
        reason: "contact has opted out of SMS",
        attempt_outcome: "definitively_rejected",
      },
    ]);
  });

  it("records retry actor, action, and evidence in the retired claim transaction", async () => {
    const sequence = await seedSequence("retry-audit");
    const lead = await seedLead("+18175552005");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const claimId = await seedClaim(enrollmentId, sequence.stepId);
    await pauseEnrollment(enrollmentId, "provider_failed");
    const user = await createOrgUser(supabase, {
      orgId: await orgId(),
      email: "sequence-recovery-audit-" + Date.now() + "@example.test",
      role: "member",
    });
    try {
      const retry = await clientForUser(user.jwt).rpc("retry_sequence_step", {
        p_enrollment_id: enrollmentId,
      });
      expect(retry.error).toBeNull();
      expect(retry.data?.[0]?.outcome).toBe("retried");
      const { data: retired } = await supabase
        .from("sequence_step_runs")
        .select("claim_active, recovery_actor_user_id, recovery_action, recovery_evidence")
        .eq("id", claimId)
        .single();
      expect(retired).toMatchObject({
        claim_active: false,
        recovery_actor_user_id: user.userId,
        recovery_action: "explicit_retry",
      });
      expect(retired?.recovery_evidence).toContain("proven");

      const resumeLead = await seedLead("+18175552010");
      const resumeEnrollment = await enroll(sequence.id, resumeLead.propertyId);
      const resumeClaimId = await seedClaim(resumeEnrollment, sequence.stepId, "not_attempted");
      await pauseEnrollment(resumeEnrollment, "call_in_progress");
      const resume = await clientForUser(user.jwt).rpc("resume_sequence_enrollment", {
        p_enrollment_id: resumeEnrollment,
      });
      expect(resume.error).toBeNull();
      expect(resume.data?.[0]?.outcome).toBe("resumed");
      const { data: resumedClaim } = await supabase
        .from("sequence_step_runs")
        .select("claim_active, recovery_actor_user_id, recovery_action, recovery_evidence")
        .eq("id", resumeClaimId)
        .single();
      expect(resumedClaim).toMatchObject({
        claim_active: false,
        recovery_actor_user_id: user.userId,
        recovery_action: "resume",
      });
      expect(resumedClaim?.recovery_evidence).toContain("proven no-attempt");
    } finally {
      await supabase.auth.admin.deleteUser(user.userId);
    }
  });

  it("rolls back enrollment and claim audit when the cancellation event cannot append", async () => {
    const sequence = await seedSequence("cancel-audit-rollback");
    const lead = await seedLead("+18175552008");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const claimId = await seedClaim(enrollmentId, sequence.stepId, "not_attempted");
    const { error: conflictError } = await supabase.from("lead_events").insert({
      org_id: await orgId(),
      property_id: lead.propertyId,
      actor_type: "system",
      event_type: "sequence_canceled",
      payload: { conflict: true },
      source_type: "sequence_enrollments.canceled",
      source_id: enrollmentId,
    });
    if (conflictError) throw new Error(conflictError.message);

    const canceled = await supabase.rpc("cancel_sequence_enrollment", {
      p_enrollment_id: enrollmentId,
    });
    expect(canceled.error).toBeTruthy();
    const [{ data: enrollment }, { data: claim }] = await Promise.all([
      supabase
        .from("sequence_enrollments")
        .select("status, next_run_at")
        .eq("id", enrollmentId)
        .single(),
      supabase
        .from("sequence_step_runs")
        .select("claim_active, attempt_outcome, recovery_actor_user_id, recovery_action, recovery_evidence")
        .eq("id", claimId)
        .single(),
    ]);
    expect(enrollment?.status).toBe("active");
    expect(claim).toMatchObject({
      claim_active: true,
      attempt_outcome: "not_attempted",
      recovery_actor_user_id: null,
      recovery_action: null,
      recovery_evidence: null,
    });
  });

  it("cancels atomically with audited claim context and preserves the active fence", async () => {
    const sequence = await seedSequence("audited-cancel");
    const lead = await seedLead("+18175552007");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const { data: message, error: messageError } = await supabase
      .from("messages")
      .insert({
        channel: "sms",
        direction: "outbound",
        status: "pending",
        property_id: lead.propertyId,
        contact_id: lead.contactId,
        from_address: MOCK_SENDER_PRIMARY,
        to_address: "+18175552007",
        body: "audited cancellation",
      })
      .select("id")
      .single();
    if (messageError || !message) throw new Error(messageError?.message ?? "cancel message seed failed");
    const { data: claim, error: claimError } = await supabase
      .from("sequence_step_runs")
      .insert({
        enrollment_id: enrollmentId,
        step_id: sequence.stepId,
        scheduled_for: testNow.toISOString(),
        message_id: message.id,
        attempt_outcome: "unknown",
        claim_active: true,
      })
      .select("id")
      .single();
    if (claimError || !claim) throw new Error(claimError?.message ?? "cancel claim seed failed");

    const user = await createOrgUser(supabase, {
      orgId: await orgId(),
      email: `sequence-cancel-audit-${randomUUID()}@example.test`,
      role: "member",
    });
    let foreignOwner: Awaited<ReturnType<typeof createOrgUser>> | null = null;
    let foreignMember: Awaited<ReturnType<typeof createOrgUser>> | null = null;
    try {
      const canceled = await clientForUser(user.jwt).rpc("cancel_sequence_enrollment", {
        p_enrollment_id: enrollmentId,
      });
      expect(canceled.error).toBeNull();
      expect(canceled.data).toHaveLength(1);
      expect(canceled.data?.[0]).toMatchObject({
        outcome: "canceled",
        claim_id: claim.id,
        message_id: message.id,
        attempt_outcome: "unknown",
        claim_active: true,
        actor_id: user.userId,
      });

      const [{ data: enrollment }, { data: claimAfter }, { data: event }] = await Promise.all([
        supabase
          .from("sequence_enrollments")
          .select("status, next_run_at")
          .eq("id", enrollmentId)
          .single(),
        supabase
          .from("sequence_step_runs")
          .select("claim_active, attempt_outcome, recovery_actor_user_id, recovery_action, recovery_evidence")
          .eq("id", claim.id)
          .single(),
        supabase
          .from("lead_events")
          .select("actor_type, actor_id, event_type, payload, source_type, source_id")
          .eq("source_type", "sequence_enrollments.canceled")
          .eq("source_id", enrollmentId)
          .single(),
      ]);
      expect(enrollment).toEqual({ status: "completed", next_run_at: null });
      expect(claimAfter).toMatchObject({
        claim_active: true,
        attempt_outcome: "unknown",
        recovery_actor_user_id: user.userId,
        recovery_action: "cancel",
      });
      expect(claimAfter?.recovery_evidence).toContain(claim.id);
      expect(claimAfter?.recovery_evidence).toContain("unknown");
      expect(event).toMatchObject({
        actor_type: "user",
        actor_id: user.userId,
        event_type: "sequence_canceled",
        source_type: "sequence_enrollments.canceled",
        source_id: enrollmentId,
      });
      expect(event?.payload).toMatchObject({
        enrollment_id: enrollmentId,
        sequence_id: sequence.id,
        claim_id: claim.id,
        message_id: message.id,
        attempt_outcome: "unknown",
        claim_active: true,
        recovery_action: "cancel",
      });

      foreignOwner = await createOrgUser(supabase, {
        orgId: TEST_ORG_B_ID,
        email: `sequence-cancel-foreign-owner-${randomUUID()}@example.test`,
        role: "owner",
      });
      foreignMember = await createOrgUser(supabase, {
        orgId: TEST_ORG_B_ID,
        email: `sequence-cancel-foreign-member-${randomUUID()}@example.test`,
        role: "member",
      });
      const foreign = await clientForUser(foreignMember.jwt).rpc("cancel_sequence_enrollment", {
        p_enrollment_id: enrollmentId,
      });
      expect(foreign.error).toBeNull();
      expect(foreign.data?.[0]?.outcome).toBe("not_authorized");
      const { data: unchanged } = await supabase
        .from("sequence_step_runs")
        .select("claim_active, attempt_outcome, recovery_actor_user_id, recovery_action")
        .eq("id", claim.id)
        .single();
      expect(unchanged).toMatchObject({
        claim_active: true,
        attempt_outcome: "unknown",
        recovery_actor_user_id: user.userId,
        recovery_action: "cancel",
      });
    } finally {
      if (foreignMember) await supabase.auth.admin.deleteUser(foreignMember.userId);
      if (foreignOwner) await supabase.auth.admin.deleteUser(foreignOwner.userId);
      await supabase.auth.admin.deleteUser(user.userId);
    }
  });

  it("keeps provider_failed and NULL-pause resumes behind explicit retry, and blocks a tenant mismatch", async () => {
    const sequence = await seedSequence("recovery-gates");
    const lead = await seedLead("+18175552006");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const claimId = await seedClaim(enrollmentId, sequence.stepId);
    await pauseEnrollment(enrollmentId, "provider_failed");

    const directResume = await supabase.rpc("resume_sequence_enrollment", {
      p_enrollment_id: enrollmentId,
      p_actor_user_id: null,
    });
    expect(directResume.error).toBeNull();
    expect(directResume.data?.[0]?.outcome).toBe("retry_required");

    await supabase.from("sequence_enrollments").update({ pause_reason: null }).eq("id", enrollmentId);
    const nullReasonRetry = await supabase.rpc("retry_sequence_step", {
      p_enrollment_id: enrollmentId,
      p_actor_user_id: null,
    });
    expect(nullReasonRetry.error).toBeNull();
    expect(nullReasonRetry.data?.[0]?.outcome).toBe("reconciliation_required");

    const otherOrgOwner = await createOrgUser(supabase, {
      orgId: TEST_ORG_B_ID,
      email: `sequence-recovery-tenant-owner-${randomUUID()}@example.test`,
      role: "owner",
    });
    let otherOrg: Awaited<ReturnType<typeof createOrgUser>> | null = null;
    try {
      otherOrg = await createOrgUser(supabase, {
        orgId: TEST_ORG_B_ID,
        email: `sequence-recovery-tenant-${randomUUID()}@example.test`,
        role: "member",
      });
      const foreign = clientForUser(otherOrg.jwt);
      const foreignRetry = await foreign.rpc("retry_sequence_step", {
        p_enrollment_id: enrollmentId,
        p_actor_user_id: otherOrg.userId,
      });
      expect(foreignRetry.error).toBeNull();
      expect(foreignRetry.data?.[0]?.outcome).toBe("reconciliation_required");
      const foreignResume = await foreign.rpc("resume_sequence_enrollment", {
        p_enrollment_id: enrollmentId,
        p_actor_user_id: otherOrg.userId,
      });
      expect(foreignResume.error).toBeNull();
      expect(foreignResume.data?.[0]?.outcome).toBe("not_authorized");
    } finally {
      if (otherOrg) await supabase.auth.admin.deleteUser(otherOrg.userId);
      await supabase.auth.admin.deleteUser(otherOrgOwner.userId);
    }

    const { data: unchangedClaim } = await supabase
      .from("sequence_step_runs")
      .select("id, claim_active, attempt_outcome, recovery_action")
      .eq("id", claimId)
      .single();
    expect(unchangedClaim).toMatchObject({
      claim_active: true,
      attempt_outcome: "definitively_rejected",
      recovery_action: null,
    });
  });
});
