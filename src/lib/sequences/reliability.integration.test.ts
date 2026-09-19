import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

import { createTestClient } from "@tests/integration/client";
import { seedSenderCatalog, MOCK_SENDER_PRIMARY } from "@tests/integration/delivery";
import {
  clientForUser,
  createOrgUser,
  getCanonicalTestOrgId,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

import { runSequenceTick } from "@/app/api/cron/sequence-tick/handlers";
import * as messagingSend from "@/lib/messaging/send";
import * as receiptPersistence from "@/lib/messaging/receipt-persistence";
import {
  getMockMessageLog,
  MockMessagingProvider,
  resetMockState,
} from "@/lib/messaging/providers/mock";
import { enrollLead, pausePropertyEnrollments, resumeEnrollment } from "./enrollment";
import { retrySequenceStep } from "./enrollment";
import { processEnrollmentTick } from "./tick";
import type { Database } from "@/lib/supabase/types";
import type { SmsOutboundInput, SmsSendResult } from "@/lib/messaging/types";
import { ProviderError } from "@/lib/errors/classes";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import { selectSafeApplicationClock } from "@tests/sequence-readiness/clock";

/**
 * These tests deliberately drive the native sequence path through
 * `runSequenceTick`/`processEnrollmentTick`.  That path calls
 * `sendSmsToContact` directly; it does not enqueue a message for the
 * scheduled-message drain to release later.
 */

const supabase = createTestClient();
// Claims and stale-claim RPC predicates use database-created timestamps while
// due scheduling and quiet-hours checks use application Date. DB_T0 remains
// the real database anchor for stale-claim aging. T0 is the application
// anchor selected by the shared fixture clock and may be later than DB_T0 so
// the entire lifecycle horizon remains inside a supported send window.
let DB_T0 = new Date();
let T0 = new Date();
let safeTestState = "GU";

// retry_sequence_step schedules at SQL now(); resume_sequence_enrollment adds
// the current step delay. Every recovery fixture below targets a delay-0
// current step. The lifecycle itself advances through +30 minutes.
const MAX_RECOVERY_BACKOFF_MINUTES = 0;
const MAX_LIFECYCLE_ADVANCE_MINUTES = 30;
const SAFE_CLOCK_HORIZON_MINUTES = Math.max(
  MAX_RECOVERY_BACKOFF_MINUTES,
  MAX_LIFECYCLE_ADVANCE_MINUTES,
);

type SeededLead = { propertyId: string; contactId: string; phone: string };

let providerInvocations: SmsOutboundInput[] = [];
const originalMockSend = MockMessagingProvider.prototype.sendSms;
const realSendSmsToContact = messagingSend.sendSmsToContact;

async function orgId(): Promise<string> {
  return getCanonicalTestOrgId(supabase);
}

function createAnonClient(): SupabaseClient<Database> {
  const url = process.env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing disposable Supabase anon credentials");
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function seedSequence(
  name: string,
  steps: Array<{
    delay: number;
    body?: string;
    action?: "send_sms" | "change_status";
    targetStatus?: string;
  }>,
  options: { appendOptOut?: boolean } = {},
): Promise<{ id: string; stepIds: string[] }> {
  const { data: sequence, error: sequenceError } = await supabase
    .from("sequences")
    .insert({
      org_id: await orgId(),
      name,
      append_opt_out: options.appendOptOut ?? false,
    })
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
        template_body: step.body ?? null,
        target_status: step.targetStatus ?? null,
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

async function seedLead(
  phone: string,
  address = "1 Sequence Reliability Ln",
  state = safeTestState,
): Promise<SeededLead> {
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      first_name: "Sequence",
      last_name: "Reliability",
      phone_1: phone,
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
    source: "sequence-reliability-test",
  });
  if (consentError) throw new Error(`consent seed failed: ${consentError.message}`);

  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .insert({
      address,
      state,
      status: "new_lead",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (propertyError || !property) {
    throw new Error(`property seed failed: ${propertyError?.message ?? "missing row"}`);
  }

  // Native automated sends require a sticky business sender when one exists.
  // Keep this inbound row out of the provider-invocation ledger: it is only
  // the sender fixture, not a send under test.
  const { error: inboundError } = await supabase.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    property_id: property.id,
    contact_id: contact.id,
    from_address: phone,
    to_address: MOCK_SENDER_PRIMARY,
    body: "seed inbound business sender",
  });
  if (inboundError) throw new Error(`inbound seed failed: ${inboundError.message}`);

  return { propertyId: property.id, contactId: contact.id, phone };
}

async function enroll(sequenceId: string, propertyId: string): Promise<string> {
  const outcome = await enrollLead(supabase, { sequenceId, propertyId });
  if (outcome.status !== "enrolled") {
    throw new Error(`enrollment failed: ${outcome.status}`);
  }
  return outcome.enrollmentId;
}

async function loadEnrollment(client: SupabaseClient<Database>, enrollmentId: string) {
  const { data, error } = await client
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
  if (error || !data) throw new Error(`scheduler snapshot failed: ${error?.message ?? "missing row"}`);
  return data;
}

/**
 * PostgREST serializes a database timestamp at microsecond precision while
 * JavaScript Date truncates it to milliseconds.  Move one bounded millisecond
 * beyond the persisted due time before asking the application scheduler to
 * select it; this keeps the DB predicate and fake application clock ordered.
 */
function setApplicationTimeAfterPersistedDue(nextRunAt: string): Date {
  // Recovery RPCs calculate next_run_at from database now(), which may be
  // earlier than the application clock selected for quiet-hours safety. Never
  // move the fake application clock backwards into a quiet window.
  const persistedDue = new Date(nextRunAt).getTime() + 1;
  const applicationDue = new Date(Math.max(Date.now(), persistedDue));
  vi.setSystemTime(applicationDue);
  const quiet = checkQuietHours(safeTestState, applicationDue);
  const details = quiet.ok
    ? `${quiet.zone} ${quiet.localTime}`
    : `${quiet.reason} ${quiet.zone ?? "unknown"} ${quiet.localTime ?? "unknown"}`;
  expect(
    quiet.ok,
    `recovery clock ${applicationDue.toISOString()} left ${safeTestState} send window (${details})`,
  ).toBe(true);
  return applicationDue;
}

/**
 * Inject only a post-provider sequence-step-run bookkeeping failure while
 * leaving every other query on the real Supabase client.  This models the
 * native ambiguous boundary: the mock provider accepted the SMS, then the
 * worker could not persist the accepted provider result on its claim row.
 */
function clientWithRunUpdateFailure(
  base: SupabaseClient<Database>,
): SupabaseClient<Database> {
  const client = Object.create(base) as SupabaseClient<Database>;
  const baseFrom = base.from.bind(base);
  client.from = ((table: string) => {
    const builder = baseFrom(table as never) as unknown as Record<string, unknown>;
    if (table !== "sequence_step_runs") return builder as never;

    return new Proxy(builder, {
      get(target, property, receiver) {
        if (property === "update") {
          return () => {
            const failedUpdate: Record<string, unknown> = {};
            failedUpdate.eq = () => failedUpdate;
            failedUpdate.select = () => failedUpdate;
            failedUpdate.maybeSingle = () =>
              Promise.resolve({
                data: null,
                error: { message: "injected sequence-step-run receipt failure" },
              });
            return failedUpdate;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as never;
  }) as SupabaseClient<Database>["from"];
  return client;
}

type ClaimBarrier = {
  entered: Promise<void>;
  arrive: () => Promise<void>;
  release: () => void;
};

function createClaimBarrier(participants: number): ClaimBarrier {
  let arrivals = 0;
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  return {
    entered,
    arrive: async () => {
      arrivals += 1;
      if (arrivals === participants) enteredResolve();
      await released;
    },
    release: () => releaseResolve(),
  };
}

/**
 * Hold the terminal `.single()` that submits a sequence-step claim until both
 * independent clients have reached it.  This synchronizes the actual INSERT
 * requests; a provider-call latch alone allows the winner to claim long
 * before the other client has reached the unique constraint.
 */
function clientWithClaimBarrier(
  base: SupabaseClient<Database>,
  barrier: ClaimBarrier,
): SupabaseClient<Database> {
  const client = Object.create(base) as SupabaseClient<Database>;
  const baseFrom = base.from.bind(base);

  const wrapClaimBuilder = (builder: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(builder, {
      get(target, property, receiver) {
        if (property === "select") {
          return (...args: unknown[]) =>
            wrapClaimBuilder(
              Reflect.apply(target[property] as (...values: unknown[]) => Record<string, unknown>, target, args),
            );
        }
        if (property === "single" || property === "maybeSingle") {
          return async (...args: unknown[]) => {
            await barrier.arrive();
            return Reflect.apply(
              target[property] as (...values: unknown[]) => unknown,
              target,
              args,
            );
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

  client.from = ((table: string) => {
    const builder = baseFrom(table as never) as unknown as Record<string, unknown>;
    if (table !== "sequence_step_runs") return builder as never;
    return new Proxy(builder, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (...args: unknown[]) =>
            wrapClaimBuilder(
              Reflect.apply(target[property] as (...values: unknown[]) => Record<string, unknown>, target, args),
            );
        }
        return Reflect.get(target, property, receiver);
      },
    }) as never;
  }) as SupabaseClient<Database>["from"];
  return client;
}

type StopTraceEvent =
  | "authorization_started"
  | "authorization_resolved"
  | "provider_invoked"
  | "provider_settled"
  | "stop_started"
  | "stop_committed";

function clientWithAuthorizationTrace(
  base: SupabaseClient<Database>,
  trace: StopTraceEvent[],
  hooks: {
    onAuthorizationStarted?: () => Promise<void> | void;
    onAuthorizationResolved?: () => Promise<void> | void;
  } = {},
): SupabaseClient<Database> {
  const client = Object.create(base) as SupabaseClient<Database>;
  const baseRpc = base.rpc.bind(base);
  client.rpc = ((fn: string, args?: Record<string, unknown>) => {
    if (fn !== "authorize_sequence_provider_attempt") {
      return baseRpc(fn as never, args as never);
    }
    trace.push("authorization_started");
    // PostgREST builders are lazy thenables. Promise.resolve schedules their
    // HTTP submission before the stop callback; this is an application
    // request-order boundary, not proof that the database transaction has
    // already acquired its row lock.
    const rpcResult = Promise.resolve(baseRpc(fn as never, args as never));
    return (async () => {
      // Start the stop after the authorization request has been queued. The
      // callback may wait for its commit while the request resolves.
      const stopStarted = Promise.resolve(hooks.onAuthorizationStarted?.());
      const result = await rpcResult;
      trace.push("authorization_resolved");
      await stopStarted;
      await hooks.onAuthorizationResolved?.();
      return result;
    })();
  }) as unknown as SupabaseClient<Database>["rpc"];
  return client;
}

describe("native authorization dispatch contract", () => {
  it("keeps provider dispatch free of intervening database work after authorization", () => {
    const sourcePath = resolve(process.cwd(), "src/lib/messaging/send.ts");
    const source = readFileSync(sourcePath, "utf8");
    const file = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    let authorizationBranch: ts.IfStatement | undefined;
    const providerCalls: ts.CallExpression[] = [];
    const databaseCallsBetweenAuthorizationAndDispatch: ts.CallExpression[] = [];
    let dispatchStart = Number.POSITIVE_INFINITY;

    const findDispatchStart = (node: ts.Node): number => {
      const statement = ts.findAncestor(
        node,
        (candidate) => ts.isVariableStatement(candidate) || ts.isExpressionStatement(candidate),
      );
      return statement?.getStart(file) ?? Number.POSITIVE_INFINITY;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node) && node.expression.getText(file) === "input.sequenceContext") {
        authorizationBranch = node;
      }
      if (ts.isCallExpression(node) && node.expression.getText(file) === "provider.sendSms") {
        providerCalls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    expect(authorizationBranch, "native sequence authorization branch").toBeDefined();
    const providerCall = providerCalls.find(
      (candidate) => candidate.getStart(file) > (authorizationBranch?.end ?? Number.MAX_SAFE_INTEGER),
    );
    expect(providerCall, "provider call after native authorization").toBeDefined();
    dispatchStart = findDispatchStart(providerCall!);
    expect(Number.isFinite(dispatchStart)).toBe(true);

    const authorizationEnd = authorizationBranch!.end;
    const inspectGap = (node: ts.Node): void => {
      const start = node.getStart(file);
      const end = node.getEnd();
      if (
        ts.isCallExpression(node) &&
        start >= authorizationEnd &&
        end <= dispatchStart &&
        /\.(?:from|rpc)$/.test(node.expression.getText(file))
      ) {
        databaseCallsBetweenAuthorizationAndDispatch.push(node);
      }
      ts.forEachChild(node, inspectGap);
    };
    inspectGap(file);

    expect(databaseCallsBetweenAuthorizationAndDispatch).toHaveLength(0);
  });
});

beforeEach(async () => {
  await resetTenantTables(supabase);
  resetMockState();
  await seedSenderCatalog(supabase, await orgId(), [MOCK_SENDER_PRIMARY]);
  const { data: clockAnchor, error: clockAnchorError } = await supabase
    .from("sequences")
    .insert({
      org_id: await orgId(),
      name: "sequence-reliability-db-clock-anchor",
      append_opt_out: false,
    })
    .select("created_at")
    .single();
  if (clockAnchorError || !clockAnchor) {
    throw new Error(
      `sequence reliability DB clock anchor failed: ${clockAnchorError?.message ?? "missing row"}`,
    );
  }
  DB_T0 = new Date(clockAnchor.created_at);
  const safeClock = selectSafeApplicationClock(DB_T0, SAFE_CLOCK_HORIZON_MINUTES);
  T0 = safeClock.applicationNow;
  safeTestState = safeClock.state;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  providerInvocations = [];
  vi.spyOn(MockMessagingProvider.prototype, "sendSms").mockImplementation(
    async function (this: MockMessagingProvider, input: SmsOutboundInput): Promise<SmsSendResult> {
      providerInvocations.push(input);
      return originalMockSend.call(this, input);
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native sequence lifecycle and due scheduling", () => {
  it("fires two SMS steps and a due status-change step, then completes the enrollment", async () => {
    const sequence = await seedSequence("native-three-step", [
      { delay: 0, body: "native-step-0 {{property_address}}" },
      { delay: 10, body: "native-step-1 {{property_address}}" },
      { delay: 10, action: "change_status", targetStatus: "contacted" },
    ], { appendOptOut: true });
    const lead = await seedLead("+18175551001");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);

    const first = await runSequenceTick(supabase);
    expect(first.outcomes.sent).toBe(1);
    expect(providerInvocations).toHaveLength(1);
    expect(providerInvocations[0]).toMatchObject({
      to: lead.phone,
      from: MOCK_SENDER_PRIMARY,
    });
    expect(providerInvocations[0].body).toMatch(/^native-step-0 1 Sequence Reliability Ln /);
    expect(providerInvocations[0].body).toContain("STOP");

    let enrollment = await loadEnrollment(supabase, enrollmentId);
    expect(enrollment).toMatchObject({ status: "active", current_step_index: 1 });
    expect(new Date(enrollment.next_run_at!).getTime()).toBe(T0.getTime() + 10 * 60_000);

    vi.setSystemTime(new Date(T0.getTime() + 9 * 60_000));
    const early = await runSequenceTick(supabase);
    expect(early.processed).toBe(0);
    expect(providerInvocations).toHaveLength(1);

    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000));
    const second = await runSequenceTick(supabase);
    expect(second.outcomes.sent).toBe(1);
    expect(providerInvocations).toHaveLength(2);
    expect(providerInvocations[1]).toMatchObject({
      to: lead.phone,
      from: MOCK_SENDER_PRIMARY,
    });
    expect(providerInvocations[1].body).toMatch(/^native-step-1 1 Sequence Reliability Ln /);
    expect(providerInvocations[1].body).toContain("STOP");

    vi.setSystemTime(new Date(T0.getTime() + 20 * 60_000));
    const third = await runSequenceTick(supabase);
    expect(third.outcomes.status_changed).toBe(1);
    expect(providerInvocations).toHaveLength(2);

    enrollment = await loadEnrollment(supabase, enrollmentId);
    expect(enrollment.status).toBe("completed");
    expect(enrollment.current_step_index).toBe(2);
    expect(enrollment.next_run_at).toBeNull();

    const { data: runs, error: runError } = await supabase
      .from("sequence_step_runs")
      .select("step_id, run_at, message_id")
      .eq("enrollment_id", enrollmentId);
    expect(runError).toBeNull();
    expect(runs).toHaveLength(3);
    expect(new Set(runs?.map((run) => run.step_id))).toEqual(new Set(sequence.stepIds));
    expect(runs?.filter((run) => run.message_id !== null)).toHaveLength(2);
    expect(runs?.every((run) => run.run_at !== null)).toBe(true);

    const { data: property } = await supabase
      .from("properties")
      .select("status")
      .eq("id", lead.propertyId)
      .single();
    expect(property?.status).toBe("contacted");

    const { data: outbound } = await supabase
      .from("messages")
      .select("status, body")
      .eq("direction", "outbound")
      .eq("contact_id", lead.contactId);
    expect(outbound).toHaveLength(2);
    expect(outbound?.every((message) => message.status === "sent")).toBe(true);

    vi.setSystemTime(new Date(T0.getTime() + 30 * 60_000));
    const afterCompletion = await runSequenceTick(supabase);
    expect(afterCompletion.processed).toBe(0);
    expect(providerInvocations).toHaveLength(2);
  });
});

describe("native claim concurrency", () => {
  it("uses one provider invocation in 20 synchronized two-client claim trials and still progresses an unrelated enrollment", async () => {
    const trialEnrollments: string[] = [];
    const trialLeads: SeededLead[] = [];

    for (let trial = 0; trial < 20; trial += 1) {
      const sequence = await seedSequence(`native-concurrent-claim-${trial}`, [
        { delay: 0, body: `one claim only trial ${trial}` },
      ]);
      const lead = await seedLead(`+181755${String(10020 + trial).padStart(5, "0")}`);
      const enrollmentId = await enroll(sequence.id, lead.propertyId);
      trialEnrollments.push(enrollmentId);
      trialLeads.push(lead);

      const barrier = createClaimBarrier(2);
      const clientA = clientWithClaimBarrier(createTestClient(), barrier);
      const clientB = clientWithClaimBarrier(createTestClient(), barrier);
      const pendingTicks = Promise.all([
        runSequenceTick(clientA),
        runSequenceTick(clientB),
      ]);
      await barrier.entered;
      barrier.release();
      const summaries = await pendingTicks;

      expect(
        summaries.reduce((count, summary) => count + (summary.outcomes.sent ?? 0), 0),
      ).toBe(1);
      expect(providerInvocations).toHaveLength(trial + 1);
      const { count: runCount } = await supabase
        .from("sequence_step_runs")
        .select("id", { count: "exact", head: true })
        .eq("enrollment_id", enrollmentId);
      expect(runCount).toBe(1);
      expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("completed");
    }

    // The mock external id is deterministic from body + recipient, so the
    // invocation ledger above must remain independent of provider IDs.  A
    // separate due enrollment proves the claim fence does not stall unrelated
    // work after all the synchronized races.
    const controlSequence = await seedSequence("native-concurrent-positive-control", [
      { delay: 0, body: "independent control enrollment" },
    ]);
    const controlLead = await seedLead("+18175550199");
    const controlEnrollmentId = await enroll(controlSequence.id, controlLead.propertyId);
    const control = await runSequenceTick(createTestClient());
    expect(control.outcomes.sent).toBe(1);
    expect(providerInvocations).toHaveLength(21);
    expect(getMockMessageLog()).toHaveLength(21);
    expect((await loadEnrollment(supabase, controlEnrollmentId)).status).toBe("completed");
    expect(trialEnrollments).toHaveLength(20);
    expect(trialLeads).toHaveLength(20);
  });
});

describe("native retained-claim recovery", () => {
  it("does not strand a definitive provider failure: repair after proving no send, resume, and accept exactly once", async () => {
    const sequence = await seedSequence("native-definitive-failure", [
      { delay: 0, body: "FAIL definitive native failure" },
    ]);
    const lead = await seedLead("+18175551003");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);

    const providerSpy = vi.spyOn(MockMessagingProvider.prototype, "sendSms");
    providerSpy.mockImplementation(
      async function (this: MockMessagingProvider, input: SmsOutboundInput): Promise<SmsSendResult> {
        providerInvocations.push(input);
        // Run the mock's normal logging path, then replace its generic error
        // with the adapter-level marker that is the only proof of a
        // definitive provider rejection.
        try {
          return await originalMockSend.call(this, input);
        } catch {
          throw new ProviderError(
            "mock provider definitively rejected the SMS",
            "mock",
            { definitiveRejection: true },
          );
        }
      },
    );

    const first = await runSequenceTick(supabase);
    expect(first.outcomes.failed).toBe(1);
    expect(providerInvocations).toHaveLength(1);
    expect(getMockMessageLog()[0].state).toBe("failed");

    const { data: failedMessage } = await supabase
      .from("messages")
      .select("status, external_id, error_message")
      .eq("contact_id", lead.contactId)
      .eq("direction", "outbound")
      .single();
    expect(failedMessage).toMatchObject({ status: "failed", external_id: null });
    expect(failedMessage?.error_message).toContain("definitively rejected");
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("paused");
    expect((await loadEnrollment(supabase, enrollmentId)).pause_reason).toBe("provider_failed");

    // Definitive rejection is safe to hold for explicit repair; normal ticks
    // must not hot-loop or invoke the provider again while it is paused.
    const immediateRetry = await runSequenceTick(createTestClient());
    expect(immediateRetry.processed).toBe(0);
    expect(providerInvocations).toHaveLength(1);
    const laterRetryOne = await runSequenceTick(createTestClient());
    const laterRetryTwo = await runSequenceTick(createTestClient());
    expect(laterRetryOne.processed).toBe(0);
    expect(laterRetryTwo.processed).toBe(0);
    expect(providerInvocations).toHaveLength(1);
    expect((await loadEnrollment(supabase, enrollmentId)).pause_reason).toBe("provider_failed");

    // The failed message has no external id and the provider explicitly
    // rejected it.  Repair the body, then use the guarded retry RPC.  The
    // test must retain the old claim row for audit; only the RPC retires it
    // and creates the next audited claim atomically.
    const { error: bodyRepairError } = await supabase
      .from("sequence_steps")
      .update({ template_body: "repaired native body" })
      .eq("id", sequence.stepIds[0]);
    expect(bodyRepairError).toBeNull();
    expect((await resumeEnrollment(supabase, enrollmentId)).status).toBe("reconciliation_required");
    const definitiveRetry = await retrySequenceStep(supabase, enrollmentId);
    expect(definitiveRetry).toMatchObject({ status: "retried" });
    const { data: definitiveRetrySchedule, error: definitiveRetryScheduleError } = await supabase
      .from("sequence_enrollments")
      .select("next_run_at")
      .eq("id", enrollmentId)
      .single();
    expect(definitiveRetryScheduleError).toBeNull();
    expect(definitiveRetrySchedule?.next_run_at).not.toBeNull();
    expect(new Date(definitiveRetrySchedule!.next_run_at!).getTime()).toBeGreaterThanOrEqual(
      DB_T0.getTime(),
    );
    setApplicationTimeAfterPersistedDue(definitiveRetrySchedule!.next_run_at!);
    const repaired = await runSequenceTick(supabase);
    expect(repaired.outcomes.sent).toBe(1);
    expect(providerInvocations).toHaveLength(2);
    expect(providerInvocations.filter((input) => !input.body.startsWith("FAIL"))).toHaveLength(1);
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("completed");

    const { data: attempts } = await supabase
      .from("sequence_step_runs")
      .select("claim_active, attempt_outcome, failure_reason, run_at")
      .eq("enrollment_id", enrollmentId)
      .order("created_at", { ascending: true });
    expect(attempts).toHaveLength(2);
    expect(attempts?.[0]).toMatchObject({
      claim_active: false,
      attempt_outcome: "definitively_rejected",
    });
    expect(attempts?.[1]).toMatchObject({
      claim_active: true,
      attempt_outcome: "accepted",
    });
  });

  it("holds a crash-after-claim until its bounded stale window, then permits explicit retry only after proven no-send", async () => {
    const sequence = await seedSequence("native-crash-after-claim", [
      { delay: 0, body: "crash boundary native body" },
    ]);
    const lead = await seedLead("+18175551004");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const clientA = createTestClient();
    const clientB = createTestClient();
    const snapshot = await loadDueSnapshot(clientA, enrollmentId);

    const crash = vi
      .spyOn(messagingSend, "sendSmsToContact")
      .mockRejectedValueOnce(new Error("simulated worker crash after claim"));
    await expect(processEnrollmentTick(clientA, snapshot)).rejects.toThrow(
      "simulated worker crash after claim",
    );
    crash.mockRestore();
    // The worker died before the native authorization/provider boundary. No
    // provider invocation or message breadcrumb exists, which is durable
    // not_attempted evidence rather than an ambiguous acceptance.
    expect(providerInvocations).toHaveLength(0);
    expect(getMockMessageLog()).toHaveLength(0);

    const { data: retainedClaim } = await supabase
      .from("sequence_step_runs")
      .select("id, created_at, attempt_started_at, attempt_outcome, run_at, message_id, claim_active")
      .eq("enrollment_id", enrollmentId)
      .single();
    expect(retainedClaim).toMatchObject({
      attempt_outcome: "not_attempted",
      run_at: null,
      claim_active: true,
    });

    // A fresh claim is still owned by a live worker.  The next tick must not
    // pause/reclaim it immediately just because the worker disappeared.
    const liveRetry = await runSequenceTick(clientB);
    expect(liveRetry.outcomes.skipped_already_claimed).toBe(1);
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("active");
    expect(providerInvocations).toHaveLength(0);

    // A second due tick before the bounded stale threshold must also expose
    // the retained claim rather than silently creating another provider call.
    const liveRetryAgain = await runSequenceTick(clientB);
    expect(liveRetryAgain.outcomes.skipped_already_claimed).toBe(1);
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("active");
    expect(providerInvocations).toHaveLength(0);

    // Simulate a worker that really died.  The claim is now older than the
    // bounded 15-minute stale window; this is the point at which an actionable
    // reconciliation pause is safe.  It still must never auto-retry a stale
    // claim; any resend needs an explicit proven-no-send repair.
    const staleAt = new Date(DB_T0.getTime() - 16 * 60_000).toISOString();
    const { error: ageError } = await supabase
      .from("sequence_step_runs")
      .update({ created_at: staleAt, attempt_started_at: staleAt })
      .eq("id", retainedClaim!.id);
    expect(ageError).toBeNull();

    const stale = await runSequenceTick(clientB);
    expect(stale.outcomes.paused).toBe(1);
    const paused = await loadEnrollment(supabase, enrollmentId);
    expect(paused.status).toBe("paused");
    expect(paused.pause_reason).toBe("provider_failed");
    expect(providerInvocations).toHaveLength(0);

    // Once the stale claim has been surfaced as an actionable pause, later
    // due ticks must remain quiet and preserve that state.
    const afterStaleOne = await runSequenceTick(clientB);
    const afterStaleTwo = await runSequenceTick(clientB);
    expect(afterStaleOne.processed).toBe(0);
    expect(afterStaleTwo.processed).toBe(0);
    expect(providerInvocations).toHaveLength(0);
    expect((await loadEnrollment(supabase, enrollmentId)).pause_reason).toBe("provider_failed");

    // This claim is durable not_attempted proof, so the explicit retry RPC
    // may retire it and create a new audited claim.  Normal resume remains
    // guarded; no test-side claim deletion is allowed.
    expect((await resumeEnrollment(supabase, enrollmentId)).status).toBe("reconciliation_required");
    await supabase
      .from("sequence_steps")
      .update({ template_body: "repaired after proven no-send crash" })
      .eq("id", sequence.stepIds[0]);
    const crashRetry = await retrySequenceStep(supabase, enrollmentId);
    expect(crashRetry).toMatchObject({ status: "retried" });
    const { data: crashRetrySchedule, error: crashRetryScheduleError } = await supabase
      .from("sequence_enrollments")
      .select("next_run_at")
      .eq("id", enrollmentId)
      .single();
    expect(crashRetryScheduleError).toBeNull();
    expect(crashRetrySchedule?.next_run_at).not.toBeNull();
    expect(new Date(crashRetrySchedule!.next_run_at!).getTime()).toBeGreaterThanOrEqual(
      DB_T0.getTime(),
    );
    setApplicationTimeAfterPersistedDue(crashRetrySchedule!.next_run_at!);
    const recovered = await runSequenceTick(supabase);
    expect(recovered.outcomes.sent).toBe(1);
    expect(providerInvocations).toHaveLength(1);
    expect(getMockMessageLog()).toHaveLength(1);
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("completed");
  });

  it("does not retry after a worker crashes after provider acceptance", async () => {
    const sequence = await seedSequence("native-crash-after-acceptance", [
      { delay: 0, body: "provider accepted before worker crash" },
    ]);
    const lead = await seedLead("+18175550106");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const clientA = createTestClient();
    const clientB = createTestClient();
    const snapshot = await loadDueSnapshot(clientA, enrollmentId);

    // Make the provider accept and log the SMS, then crash the receipt write
    // before it can stamp the messages row. The authorization RPC has already
    // linked that pending message to the claim, so the claim must retain its
    // message identity while run_at remains null and outcome stays unknown.
    const receiptCrash = vi
      .spyOn(receiptPersistence, "retryReceiptTransaction")
      .mockImplementation(async () => {
        throw new Error("simulated worker crash after provider acceptance");
      });
    const crash = vi
      .spyOn(messagingSend, "sendSmsToContact")
      .mockImplementation(async (client, input) => {
        const result = await realSendSmsToContact(client, input);
        if (result.status === "db_error") {
          throw new Error("simulated worker crash after provider acceptance");
        }
        return result;
      });
    await expect(processEnrollmentTick(clientA, snapshot)).rejects.toThrow(
      "simulated worker crash after provider acceptance",
    );
    crash.mockRestore();
    receiptCrash.mockRestore();

    expect(providerInvocations).toHaveLength(1);
    expect(getMockMessageLog()).toHaveLength(1);

    const { data: claim } = await supabase
      .from("sequence_step_runs")
      .select("id, claim_active, attempt_outcome, run_at, message_id")
      .eq("enrollment_id", enrollmentId)
      .single();
    expect(claim).toMatchObject({
      claim_active: true,
      attempt_outcome: "unknown",
      run_at: null,
    });
    expect(claim?.message_id).toBeTruthy();
    const { data: pendingMessage } = await supabase
      .from("messages")
      .select("id, status, external_id")
      .eq("id", claim!.message_id!)
      .single();
    expect(pendingMessage).toMatchObject({
      id: claim!.message_id,
      status: "pending",
      external_id: null,
    });
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("active");

    // Two fresh due ticks can only report the retained live claim. They must
    // not guess no-send from a missing sequence-step receipt and re-invoke the
    // provider.
    const freshOne = await runSequenceTick(clientB);
    const freshTwo = await runSequenceTick(clientB);
    expect(freshOne.outcomes.skipped_already_claimed).toBe(1);
    expect(freshTwo.outcomes.skipped_already_claimed).toBe(1);
    expect(providerInvocations).toHaveLength(1);
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("active");

    // Age the claim explicitly in the DB, then allow reconciliation to expose
    // an actionable pause. Even after that pause, normal ticks and both
    // recovery operations must refuse a blind resend.
    const staleAt = new Date(DB_T0.getTime() - 16 * 60_000).toISOString();
    const { error: ageError } = await supabase
      .from("sequence_step_runs")
      .update({ created_at: staleAt, attempt_started_at: staleAt })
      .eq("id", claim!.id);
    expect(ageError).toBeNull();
    const stale = await runSequenceTick(clientB);
    expect(stale.outcomes.paused).toBe(1);
    expect((await loadEnrollment(supabase, enrollmentId)).pause_reason).toBe(
      "reconciliation_required",
    );
    expect(providerInvocations).toHaveLength(1);

    expect((await resumeEnrollment(supabase, enrollmentId)).status).toBe(
      "reconciliation_required",
    );
    const acceptedRetry = await retrySequenceStep(supabase, enrollmentId);
    expect(acceptedRetry).toMatchObject({ status: "reconciliation_required" });
    const laterOne = await runSequenceTick(clientB);
    const laterTwo = await runSequenceTick(clientB);
    expect(laterOne.processed).toBe(0);
    expect(laterTwo.processed).toBe(0);
    expect(providerInvocations).toHaveLength(1);
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("paused");
  });

  it("never blindly re-sends an accepted native SMS when claim receipt bookkeeping is ambiguous", async () => {
    const sequence = await seedSequence("native-ambiguous-acceptance", [
      { delay: 0, body: "accepted before receipt write" },
    ]);
    const lead = await seedLead("+18175551005");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const clientA = createTestClient();

    const snapshot = await loadDueSnapshot(clientA, enrollmentId);
    const failingClient = clientWithRunUpdateFailure(clientA);
    const first = await processEnrollmentTick(failingClient, snapshot);
    expect(first.status).toBe("failed");
    if (first.status !== "failed") throw new Error(`unexpected first outcome: ${first.status}`);
    expect(first.message).toContain("accepted");
    expect(providerInvocations).toHaveLength(1);

    const { data: acceptedMessage } = await supabase
      .from("messages")
      .select("status, external_id")
      .eq("contact_id", lead.contactId)
      .eq("direction", "outbound")
      .single();
    expect(acceptedMessage?.status).toBe("sent");
    expect(acceptedMessage?.external_id).toBeTruthy();

    const { data: claim } = await supabase
      .from("sequence_step_runs")
      .select("id, claim_active, attempt_outcome, message_id")
      .eq("enrollment_id", enrollmentId)
      .single();
    expect(claim).toMatchObject({ claim_active: true, attempt_outcome: "unknown" });
    expect(claim?.message_id).toBeTruthy();
    expect((await loadEnrollment(supabase, enrollmentId)).pause_reason).toBe("reconciliation_required");

    // Characterize a legacy/operator pause reason that says provider_failed
    // even though the durable claim still says unknown. The retry guard must
    // remain outcome-based and deny the resend; changing this reason never
    // repairs or deletes the retained claim.
    const { error: legacyPauseReasonError } = await supabase
      .from("sequence_enrollments")
      .update({ pause_reason: "provider_failed" })
      .eq("id", enrollmentId);
    expect(legacyPauseReasonError).toBeNull();

    // Keep the claim: acceptance is ambiguous from the sequence worker's
    // perspective, so both normal resume and explicit retry must refuse to
    // make it sendable.
    expect((await resumeEnrollment(supabase, enrollmentId)).status).toBe("reconciliation_required");
    const ambiguousRetry = await retrySequenceStep(supabase, enrollmentId);
    expect(ambiguousRetry).toMatchObject({ status: "reconciliation_required" });
    const retry = await runSequenceTick(supabase);
    expect(retry.processed).toBe(0);
    expect(providerInvocations).toHaveLength(1);
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("paused");
  });

  it("denies authenticated and anonymous direct claim writes and the final authorization RPC", async () => {
    const sequence = await seedSequence("native-claim-write-guard", [
      { delay: 0, body: "claim write guard" },
    ]);
    const lead = await seedLead("+18175550111");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const first = await runSequenceTick(supabase);
    expect(first.outcomes.sent).toBe(1);

    const { data: claim, error: claimError } = await supabase
      .from("sequence_step_runs")
      .select("id, message_id, attempt_outcome")
      .eq("enrollment_id", enrollmentId)
      .single();
    expect(claimError).toBeNull();
    expect(claim?.attempt_outcome).toBe("accepted");
    expect(claim?.message_id).toBeTruthy();

    const user = await createOrgUser(supabase, {
      orgId: await orgId(),
      email: `sequence-claim-guard-${randomUUID()}@example.test`,
      role: "member",
    });
    try {
      const authenticated = clientForUser(user.jwt);
      const anon = createAnonClient();
      const directUpdate = await authenticated
        .from("sequence_step_runs")
        .update({ failure_reason: "forged authenticated write" })
        .eq("id", claim!.id)
        .select("id")
        .maybeSingle();
      expect(directUpdate.error).toBeTruthy();

      const directDelete = await authenticated
        .from("sequence_step_runs")
        .delete()
        .eq("id", claim!.id)
        .select("id")
        .maybeSingle();
      expect(directDelete.error).toBeTruthy();

      const anonymousUpdate = await anon
        .from("sequence_step_runs")
        .update({ failure_reason: "forged anonymous write" })
        .eq("id", claim!.id)
        .select("id")
        .maybeSingle();
      expect(anonymousUpdate.error !== null || anonymousUpdate.data === null).toBe(true);

      const rpcArgs = {
        p_enrollment_id: enrollmentId,
        p_step_id: sequence.stepIds[0],
        p_claim_id: claim!.id,
        p_contact_id: lead.contactId,
        p_property_id: lead.propertyId,
        p_phone: lead.phone,
        p_message_id: claim!.message_id!,
      };
      const authenticatedRpc = await authenticated.rpc(
        "authorize_sequence_provider_attempt",
        rpcArgs,
      );
      expect(authenticatedRpc.error).toBeTruthy();
      const anonymousRpc = await anon.rpc(
        "authorize_sequence_provider_attempt",
        rpcArgs,
      );
      expect(anonymousRpc.error).toBeTruthy();
    } finally {
      const { error: deleteUserError } = await supabase.auth.admin.deleteUser(user.userId);
      if (deleteUserError) throw new Error(`claim guard user cleanup failed: ${deleteUserError.message}`);
    }

    const { data: unchangedClaim } = await supabase
      .from("sequence_step_runs")
      .select("claim_active, attempt_outcome, failure_reason")
      .eq("enrollment_id", enrollmentId)
      .single();
    expect(unchangedClaim).toMatchObject({
      claim_active: true,
      attempt_outcome: "accepted",
      failure_reason: null,
    });
    expect(providerInvocations).toHaveLength(1);
  });
});

describe("native scheduler snapshot versus reply/cancel", () => {
  it.each([
    ["reply", false] as const,
    ["cancel", true] as const,
  ])(
    "does not send when a %s pauses the enrollment after the scheduler snapshot",
    async (_name, permanent) => {
      const sequence = await seedSequence(`native-snapshot-${_name}`, [
        { delay: 0, body: "must not cross cancellation barrier" },
      ]);
      const lead = await seedLead(`+1817555100${permanent ? "7" : "6"}`);
      const enrollmentId = await enroll(sequence.id, lead.propertyId);
      const schedulerClient = createTestClient();
      const replyClient = createTestClient();

      // This is the exact runtime order: scheduler SELECT first, external
      // reply/cancel mutation second, then native step processing.
      const snapshot = await loadDueSnapshot(schedulerClient, enrollmentId);
      const paused = await pausePropertyEnrollments(replyClient, {
        propertyId: lead.propertyId,
        reason: permanent ? "consent_revoked" : "inbound_reply",
        permanent,
      });
      expect(paused.paused).toBe(1);

      const trace: StopTraceEvent[] = [];
      const outcome = await processEnrollmentTick(
        clientWithAuthorizationTrace(schedulerClient, trace),
        snapshot,
      );
      expect(outcome.status).toBe("paused");
      expect(providerInvocations).toHaveLength(0);
      expect(getMockMessageLog()).toHaveLength(0);
      expect(trace).toEqual(["authorization_started", "authorization_resolved"]);

      const final = await loadEnrollment(supabase, enrollmentId);
      expect(final.status).toBe(permanent ? "opted_out" : "paused");
      expect(final.current_step_index).toBe(0);
      const { count: claimCount } = await supabase
        .from("sequence_step_runs")
        .select("id", { count: "exact", head: true })
        .eq("enrollment_id", enrollmentId);
      expect(claimCount).toBe(1);
      const { data: rejectedClaim } = await supabase
        .from("sequence_step_runs")
        .select("attempt_outcome, claim_active, failure_reason")
        .eq("enrollment_id", enrollmentId)
        .single();
      expect(rejectedClaim).toMatchObject({
        attempt_outcome: "definitively_rejected",
        claim_active: true,
      });
    },
  );

  it("allows only the already-authorized in-flight send when a reply commits after authorization, then preserves the stop", async () => {
    const sequence = await seedSequence("native-stop-after-authorization", [
      { delay: 0, body: "stop after authorization" },
    ]);
    const lead = await seedLead("+18175550108");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const schedulerClient = createTestClient();
    const replyClient = createTestClient();
    const snapshot = await loadDueSnapshot(schedulerClient, enrollmentId);
    const trace: StopTraceEvent[] = [];

    const providerSpy = vi.spyOn(MockMessagingProvider.prototype, "sendSms");
    providerSpy.mockImplementation(
      async function (this: MockMessagingProvider, input: SmsOutboundInput): Promise<SmsSendResult> {
        trace.push("provider_invoked");
        providerInvocations.push(input);
        const result = await originalMockSend.call(this, input);
        trace.push("provider_settled");
        return result;
      },
    );
    const tracedClient = clientWithAuthorizationTrace(schedulerClient, trace, {
      onAuthorizationResolved: async () => {
        trace.push("stop_started");
        const paused = await pausePropertyEnrollments(replyClient, {
          propertyId: lead.propertyId,
          reason: "inbound_reply",
          permanent: false,
        });
        expect(paused.paused).toBe(1);
        trace.push("stop_committed");
      },
    });

    const outcome = await processEnrollmentTick(tracedClient, snapshot);
    providerSpy.mockRestore();
    expect(outcome.status).toBe("failed");
    expect(trace).toEqual([
      "authorization_started",
      "authorization_resolved",
      "stop_started",
      "stop_committed",
      "provider_invoked",
      "provider_settled",
    ]);
    expect(providerInvocations).toHaveLength(1);

    const final = await loadEnrollment(supabase, enrollmentId);
    expect(final).toMatchObject({
      status: "paused",
      pause_reason: "inbound_reply",
      current_step_index: 0,
    });
    if (outcome.status !== "failed") throw new Error(`unexpected stop outcome: ${outcome.status}`);
    expect(outcome.message).toContain("accepted");

    const laterOne = await runSequenceTick(createTestClient());
    const laterTwo = await runSequenceTick(createTestClient());
    expect(laterOne.processed).toBe(0);
    expect(laterTwo.processed).toBe(0);
    expect(providerInvocations).toHaveLength(1);
  });

  it("waits for a stop started after authorization request submission and never advances the stopped enrollment", async () => {
    const sequence = await seedSequence("native-stop-during-authorization", [
      { delay: 0, body: "stop during authorization" },
    ]);
    const lead = await seedLead("+18175550109");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const schedulerClient = createTestClient();
    const replyClient = createTestClient();
    const snapshot = await loadDueSnapshot(schedulerClient, enrollmentId);
    const trace: StopTraceEvent[] = [];
    let stopCommit!: Promise<void>;

    const providerSpy = vi.spyOn(MockMessagingProvider.prototype, "sendSms");
    providerSpy.mockImplementation(
      async function (this: MockMessagingProvider, input: SmsOutboundInput): Promise<SmsSendResult> {
        trace.push("provider_invoked");
        providerInvocations.push(input);
        await stopCommit;
        const result = await originalMockSend.call(this, input);
        trace.push("provider_settled");
        return result;
      },
    );
    const tracedClient = clientWithAuthorizationTrace(schedulerClient, trace, {
      onAuthorizationStarted: () => {
        trace.push("stop_started");
        stopCommit = pausePropertyEnrollments(replyClient, {
          propertyId: lead.propertyId,
          reason: "inbound_reply",
          permanent: false,
        }).then((paused) => {
          expect(paused.paused).toBe(1);
          trace.push("stop_committed");
        });
      },
    });

    const outcome = await processEnrollmentTick(tracedClient, snapshot);
    providerSpy.mockRestore();
    // Request submission does not prove that the authorization transaction
    // acquired its lock first.  Either the stop wins before authorization
    // (paused, zero provider calls) or authorization wins and the already
    // authorized send is allowed to finish (failed, one provider call).
    expect(["paused", "failed"]).toContain(outcome.status);
    expect(trace).toContain("authorization_started");
    expect(trace).toContain("authorization_resolved");
    expect(trace).toContain("stop_committed");
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("paused");
    expect((await loadEnrollment(supabase, enrollmentId)).current_step_index).toBe(0);
    if (outcome.status === "paused") {
      expect(providerInvocations).toHaveLength(0);
      expect(trace).not.toContain("provider_invoked");
    } else {
      if (outcome.status !== "failed") throw new Error(`unexpected stop outcome: ${outcome.status}`);
      expect(providerInvocations).toHaveLength(1);
      expect(trace).toContain("provider_invoked");
      expect(trace.indexOf("provider_invoked")).toBeGreaterThan(trace.indexOf("authorization_resolved"));
      expect(trace.indexOf("provider_settled")).toBeGreaterThan(trace.indexOf("stop_committed"));
      expect(outcome.message).toContain("accepted");
    }

    const afterStopOne = await runSequenceTick(createTestClient());
    const afterStopTwo = await runSequenceTick(createTestClient());
    expect(afterStopOne.processed).toBe(0);
    expect(afterStopTwo.processed).toBe(0);
    expect(providerInvocations).toHaveLength(outcome.status === "paused" ? 0 : 1);
  });

  it("keeps a stopped enrollment quiet across two later ticks while independent due work proceeds", async () => {
    const stoppedSequence = await seedSequence("native-stop-durability", [
      { delay: 0, body: "must remain stopped" },
    ]);
    const independentSequence = await seedSequence("native-stop-independent-control", [
      { delay: 0, body: "independent control send" },
    ]);
    const stoppedLead = await seedLead("+18175550112");
    const independentLead = await seedLead("+18175550113");
    const stoppedEnrollmentId = await enroll(stoppedSequence.id, stoppedLead.propertyId);
    const independentEnrollmentId = await enroll(
      independentSequence.id,
      independentLead.propertyId,
    );

    const stoppedSnapshot = await loadDueSnapshot(supabase, stoppedEnrollmentId);
    const paused = await pausePropertyEnrollments(supabase, {
      propertyId: stoppedLead.propertyId,
      reason: "inbound_reply",
      permanent: false,
    });
    expect(paused.paused).toBe(1);
    const stoppedOutcome = await processEnrollmentTick(supabase, stoppedSnapshot);
    expect(stoppedOutcome.status).toBe("paused");
    expect(providerInvocations).toHaveLength(0);

    vi.setSystemTime(new Date(T0.getTime() + 20 * 60_000));
    const laterOne = await runSequenceTick(createTestClient());
    const laterTwo = await runSequenceTick(createTestClient());
    expect(laterOne.outcomes.sent).toBe(1);
    expect(laterTwo.processed).toBe(0);
    expect(providerInvocations).toHaveLength(1);
    expect((await loadEnrollment(supabase, stoppedEnrollmentId)).status).toBe("paused");
    expect((await loadEnrollment(supabase, stoppedEnrollmentId)).current_step_index).toBe(0);
    expect((await loadEnrollment(supabase, independentEnrollmentId)).status).toBe("completed");
  });

  it("keeps the one provider attempt allowed after a stop enters the provider call", async () => {
    const sequence = await seedSequence("native-stop-inside-provider", [
      { delay: 0, body: "stop inside provider" },
    ]);
    const lead = await seedLead("+18175550110");
    const enrollmentId = await enroll(sequence.id, lead.propertyId);
    const schedulerClient = createTestClient();
    const replyClient = createTestClient();
    const snapshot = await loadDueSnapshot(schedulerClient, enrollmentId);
    const trace: StopTraceEvent[] = [];
    let stopCommit!: Promise<void>;

    const providerSpy = vi.spyOn(MockMessagingProvider.prototype, "sendSms");
    providerSpy.mockImplementation(
      async function (this: MockMessagingProvider, input: SmsOutboundInput): Promise<SmsSendResult> {
        trace.push("provider_invoked");
        providerInvocations.push(input);
        stopCommit = pausePropertyEnrollments(replyClient, {
          propertyId: lead.propertyId,
          reason: "inbound_reply",
          permanent: false,
        }).then((paused) => {
          expect(paused.paused).toBe(1);
          trace.push("stop_committed");
        });
        await stopCommit;
        const result = await originalMockSend.call(this, input);
        trace.push("provider_settled");
        return result;
      },
    );
    const tracedClient = clientWithAuthorizationTrace(schedulerClient, trace);
    const outcome = await processEnrollmentTick(tracedClient, snapshot);
    providerSpy.mockRestore();
    expect(outcome.status).toBe("failed");
    expect(trace.indexOf("authorization_resolved")).toBeLessThan(trace.indexOf("provider_invoked"));
    expect(trace.indexOf("provider_invoked")).toBeLessThan(trace.indexOf("stop_committed"));
    expect(trace.indexOf("stop_committed")).toBeLessThan(trace.indexOf("provider_settled"));
    expect(providerInvocations).toHaveLength(1);
    expect((await loadEnrollment(supabase, enrollmentId)).status).toBe("paused");
    expect((await loadEnrollment(supabase, enrollmentId)).current_step_index).toBe(0);
    if (outcome.status !== "failed") throw new Error(`unexpected stop outcome: ${outcome.status}`);
    expect(outcome.message).toContain("accepted");
  });
});
