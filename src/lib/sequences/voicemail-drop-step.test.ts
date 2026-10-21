import { beforeEach, describe, expect, it, vi } from "vitest";

import { reportError } from "@/lib/errors/report";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import { chicagoDayWindow, readDailyCap, toE164 } from "@/lib/voicemail-drop/eligibility";
import {
  getMockVoicemailDropLog,
  resetMockVoicemailDropState,
  setMockVoicemailDropResult,
} from "@/lib/voicemail-drop/providers/mock";

import { processEnrollmentTick } from "./tick";
import { processVoicemailDropStep, renderVoicemailScript, voicemailDropCallbackUrl } from "./voicemail-drop-step";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: vi.fn() }));
vi.mock("@/lib/messaging/quiet-hours", () => ({
  checkQuietHours: vi.fn(() => ({ ok: true, localTime: "10:00", zone: "America/Chicago" })),
}));

const ENV = {
  VOICEMAIL_DROP_PROVIDER: "mock",
  DROPCOWBOY_CALLBACK_SECRET: "cb-secret",
  NEXT_PUBLIC_APP_URL: "https://sandra.test",
} as unknown as NodeJS.ProcessEnv;

const ENROLLMENT = {
  id: "enr-1",
  org_id: "org-1",
  sequence_id: "seq-1",
  property_id: "prop-1",
  contact_id: "contact-1",
  current_step_index: 0,
};

const TTS_STEP: {
  id: string;
  step_index: number;
  vm_media_id: string | null;
  vm_tts_body: string | null;
  vm_voice_id: string | null;
  vm_phone_line_id: string | null;
} = {
  id: "step-1",
  step_index: 0,
  vm_media_id: null,
  vm_tts_body: "Hi {{first_name}}, it's Norma about {{property_address}}.\n Call me back.",
  vm_voice_id: "voice-1",
  vm_phone_line_id: "line-1",
};

const CLAIM = "run-1";

type Op = {
  table: string;
  kind: "select" | "insert" | "update" | "rpc";
  payload?: unknown;
  filters: [string, string, unknown][];
  head?: boolean;
};

type World = {
  contact: Record<string, unknown> | null;
  calls: Record<string, unknown>[];
  attempts: Record<string, unknown>[];
  attemptCalls: Record<string, unknown>[];
  inbound: Record<string, unknown>[];
  norma: Record<string, unknown>[];
  normaInbound: Record<string, unknown>[];
  dropCount: number;
  auth: { authorized: boolean; reason: string | null; attempt_outcome: string } | null;
  authError: { message: string } | null;
  readError: string | null;
  failUpdate: string | null;
};

function baseWorld(over: Partial<World> = {}): World {
  return {
    contact: {
      id: "contact-1",
      first_name: "Pat",
      last_name: "Lee",
      do_not_contact: false,
      sms_opted_out: false,
      phone_1: "(816) 555-0101",
      phone_1_type: "unknown",
      phone_2: "816-555-0102",
      phone_2_type: "mobile",
      phone_3: null,
      phone_3_type: "unknown",
    },
    calls: [{ phone_e164: "+18165550101", started_at: "2026-10-01T15:00:00Z" }],
    attempts: [],
    attemptCalls: [],
    inbound: [],
    norma: [],
    normaInbound: [],
    dropCount: 0,
    auth: { authorized: true, reason: null, attempt_outcome: "unknown" },
    authError: null,
    readError: null,
    failUpdate: null,
    ...over,
  };
}

function makeClient(world: World) {
  const ops: Op[] = [];
  const resolve = (op: Op): { data: unknown; error: unknown; count?: number | null } => {
    const has = (col: string) => op.filters.some(([, c]) => c === col);
    if (op.kind === "update") {
      if (world.failUpdate === op.table) return { data: null, error: { message: "write failed" } };
      return { data: { id: "row" }, error: null };
    }
    if (op.kind === "insert") {
      if (op.table === "voicemail_drops") return { data: { id: "drop-1" }, error: null };
      return { data: { id: "row" }, error: null };
    }
    switch (op.table) {
      case "contacts":
        return { data: world.contact, error: null };
      case "call_activities":
        if (world.readError === "call_activities") return { data: null, error: { message: "boom" } };
        return { data: has("id") ? world.attemptCalls : world.calls, error: null };
      case "acquisition_attempts":
        return { data: world.attempts, error: null };
      case "messages":
        return { data: world.inbound, error: null };
      case "norma_call_requests":
        return { data: world.norma, error: null };
      case "norma_inbound_calls":
        return { data: world.normaInbound, error: null };
      case "voicemail_drops":
        return { data: null, error: null, count: world.dropCount };
      case "properties":
        return { data: { address: "12 Elm St", city: "KC", state: "MO", zip: "64111", market: null, org_id: "org-1" }, error: null };
      case "organizations":
        return { data: { name: "BMH" }, error: null };
      case "sequence_steps":
        return { data: { delay_after_previous_minutes: 60 }, error: null };
      default:
        return { data: null, error: null };
    }
  };
  const from = vi.fn((table: string) => {
    const op: Op = { table, kind: "select", filters: [] };
    ops.push(op);
    const b: Record<string, unknown> = {};
    const filter = (name: string) => (col: string, val?: unknown) => {
      op.filters.push([name, col, val]);
      return b;
    };
    b.select = (_cols?: string, opts?: { head?: boolean }) => {
      if (opts?.head) op.head = true;
      return b;
    };
    b.insert = (payload: unknown) => {
      op.kind = "insert";
      op.payload = payload;
      return b;
    };
    b.update = (payload: unknown) => {
      op.kind = "update";
      op.payload = payload;
      return b;
    };
    for (const name of ["eq", "in", "gt", "gte", "not", "order", "limit"]) b[name] = filter(name);
    b.maybeSingle = () => Promise.resolve(resolve(op));
    b.single = () => Promise.resolve(resolve(op));
    b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(op)).then(ok, fail);
    return b;
  });
  const rpc = vi.fn((name: string, args: unknown) => {
    ops.push({ table: name, kind: "rpc", payload: args, filters: [] });
    return Promise.resolve({ data: world.auth ? [world.auth] : [], error: world.authError });
  });
  return { client: { from, rpc } as never, ops };
}

const updatesTo = (ops: Op[], table: string) =>
  ops.filter((o) => o.table === table && o.kind === "update").map((o) => o.payload as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  resetMockVoicemailDropState();
});

async function run(world: World, step = TTS_STEP, env = ENV) {
  const { client, ops } = makeClient(world);
  const outcome = await processVoicemailDropStep(client, ENROLLMENT, step, { state: "MO" }, CLAIM, env);
  return { outcome, ops };
}

describe("voicemail drop step — 202 accepted", () => {
  it("queues the drop, marks the run accepted with no message id, and advances", async () => {
    const { outcome, ops } = await run(baseWorld());
    expect(outcome).toEqual({ status: "voicemail_queued", enrollmentId: "enr-1", stepIndex: 0, dropId: "drop-1" });

    const log = getMockVoicemailDropLog();
    expect(log).toHaveLength(1);
    expect(log[0].input).toEqual({
      idempotencyKey: CLAIM,
      to: "+18165550101",
      audio: { kind: "tts", ttsBody: "Hi Pat, it's Norma about 12 Elm St. Call me back.", voiceId: "voice-1" },
      phoneLineId: "line-1",
      foreignId: "drop-1",
      callbackUrl: "https://sandra.test/api/webhooks/dropcowboy/rvm-callback/cb-secret",
      mobileOnly: true,
      maxAttempts: 1,
      postalCode: "64111",
    });

    const insert = ops.find((o) => o.table === "voicemail_drops" && o.kind === "insert")!.payload as Record<string, unknown>;
    expect(insert).toMatchObject({
      step_run_id: CLAIM,
      idempotency_key: CLAIM,
      to_phone: "+18165550101",
      provider: "mock",
      audio_kind: "tts",
      attempt_outcome: "unknown",
    });
    const auth = ops.find((o) => o.kind === "rpc")!;
    expect(auth.table).toBe("authorize_sequence_provider_attempt");
    expect(auth.payload).toMatchObject({ p_claim_id: CLAIM, p_phone: "+18165550101", p_message_id: null });

    expect(updatesTo(ops, "voicemail_drops")[0]).toMatchObject({ status: "queued", attempt_outcome: "queued" });
    expect(updatesTo(ops, "sequence_step_runs")[0]).toMatchObject({ attempt_outcome: "accepted", message_id: null });
    expect(updatesTo(ops, "sequence_enrollments")[0]).toMatchObject({ current_step_index: 1 });
  });

  it("sends media drops without a script", async () => {
    const { outcome } = await run(baseWorld(), { ...TTS_STEP, vm_tts_body: null, vm_voice_id: null, vm_media_id: "media-9" });
    expect(outcome.status).toBe("voicemail_queued");
    expect(getMockVoicemailDropLog()[0].input.audio).toEqual({ kind: "media", mediaId: "media-9" });
  });
});

describe("voicemail drop step — RULING RVM-4 failures", () => {
  it.each([429, 500] as const)("%s releases the claim and retries later", async (httpStatus) => {
    setMockVoicemailDropResult({ outcome: "not_queued", httpStatus, raw: {} });
    const { outcome, ops } = await run(baseWorld());
    expect(outcome.status).toBe("rescheduled_provider_not_queued");
    const runUpdate = updatesTo(ops, "sequence_step_runs")[0];
    expect(runUpdate).toMatchObject({ claim_active: false, attempt_outcome: "definitively_rejected" });
    expect(updatesTo(ops, "voicemail_drops")[0]).toMatchObject({ status: "failed", attempt_outcome: "not_queued" });
    const enrollmentUpdate = updatesTo(ops, "sequence_enrollments")[0];
    expect(enrollmentUpdate.next_run_at).toBeDefined();
    expect(enrollmentUpdate.current_step_index).toBeUndefined();
  });

  it.each([
    { cause: "no_receipt" as const, httpStatus: 502 },
    { cause: "timeout" as const, httpStatus: null },
    { cause: "network" as const, httpStatus: null },
    { cause: "unexpected_status" as const, httpStatus: 418 },
  ])("unknown ($cause) pauses reconciliation_required and keeps the claim", async ({ cause, httpStatus }) => {
    setMockVoicemailDropResult({ outcome: "unknown", httpStatus, cause, raw: null });
    const { outcome, ops } = await run(baseWorld());
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "reconciliation_required" });
    const runUpdate = updatesTo(ops, "sequence_step_runs")[0];
    expect(runUpdate).toMatchObject({ attempt_outcome: "unknown" });
    expect(runUpdate.claim_active).toBeUndefined();
    expect(updatesTo(ops, "sequence_enrollments")[0]).toMatchObject({ status: "paused", pause_reason: "reconciliation_required" });
  });

  it("a thrown provider error is treated as unknown, never re-fired", async () => {
    const { client, ops } = makeClient(baseWorld());
    const env = { ...ENV, VOICEMAIL_DROP_PROVIDER: "mock" } as NodeJS.ProcessEnv;
    const { MockVoicemailDropProvider } = await import("@/lib/voicemail-drop/providers/mock");
    const spy = vi.spyOn(MockVoicemailDropProvider.prototype, "sendDrop").mockRejectedValueOnce(new Error("socket hang up"));
    const outcome = await processVoicemailDropStep(client, ENROLLMENT, TTS_STEP, { state: "MO" }, CLAIM, env);
    spy.mockRestore();
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "reconciliation_required" });
    expect(updatesTo(ops, "sequence_step_runs")[0]).toMatchObject({ attempt_outcome: "unknown" });
  });

  it.each([
    { outcome: "bad_request" as const, httpStatus: 400 as const },
    { outcome: "unauthorized" as const, httpStatus: 401 as const },
  ])("$httpStatus pauses provider_failed and reports", async (r) => {
    setMockVoicemailDropResult({ ...r, detail: "nope", raw: {} } as never);
    const { outcome, ops } = await run(baseWorld());
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "provider_failed" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(updatesTo(ops, "sequence_step_runs")[0]).toMatchObject({ attempt_outcome: "definitively_rejected" });
    expect(updatesTo(ops, "sequence_enrollments")[0]).toMatchObject({ pause_reason: "provider_failed" });
  });

  it("an authorization rejection pauses without calling the provider", async () => {
    const { outcome } = await run(
      baseWorld({ auth: { authorized: false, reason: "suppressed", attempt_outcome: "definitively_rejected" } }),
    );
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "provider_failed" });
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });

  it("an authorization RPC error pauses reconciliation_required without calling the provider", async () => {
    const { outcome } = await run(baseWorld({ auth: null, authError: { message: "timeout" } }));
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "reconciliation_required" });
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });
});

describe("voicemail drop step — gates before the provider", () => {
  it("provider unset: feature off, nothing fires, pauses provider_failed (same as SMS provider off)", async () => {
    const { outcome, ops } = await run(baseWorld(), TTS_STEP, { DROPCOWBOY_CALLBACK_SECRET: "x" } as never);
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "provider_failed" });
    expect(updatesTo(ops, "sequence_step_runs")[0]).toMatchObject({ attempt_outcome: "not_attempted", failure_reason: "voicemail drop provider off" });
    expect(ops.some((o) => o.table === "voicemail_drops")).toBe(false);
  });

  it("missing callback secret pauses and reports", async () => {
    const { outcome } = await run(baseWorld(), TTS_STEP, { VOICEMAIL_DROP_PROVIDER: "mock" } as never);
    expect(outcome).toMatchObject({ status: "paused", reason: "provider_failed" });
    expect(reportError).toHaveBeenCalled();
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });

  it("quiet hours retire the claim (not_attempted) and reschedule", async () => {
    vi.mocked(checkQuietHours).mockReturnValueOnce({ ok: false, reason: "outside_window", localTime: "22:00", zone: "America/Chicago" });
    const { outcome, ops } = await run(baseWorld());
    expect(outcome.status).toBe("rescheduled_quiet_hours");
    expect(updatesTo(ops, "sequence_step_runs")[0]).toMatchObject({
      claim_active: false,
      attempt_outcome: "not_attempted",
      skipped_reason: "quiet_hours",
    });
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });

  it("daily cap reached retires the claim the same way and reschedules to the next Chicago day", async () => {
    const { outcome, ops } = await run(baseWorld({ dropCount: 3 }), TTS_STEP, { ...ENV, VOICEMAIL_DROP_DAILY_CAP: "3" } as never);
    expect(outcome.status).toBe("rescheduled_daily_cap");
    expect(updatesTo(ops, "sequence_step_runs")[0]).toMatchObject({ claim_active: false, attempt_outcome: "not_attempted" });
    expect((outcome as { nextRunAt: string }).nextRunAt).toBe(chicagoDayWindow(new Date()).next.toISOString());
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });

  it("under the cap sends", async () => {
    const { outcome } = await run(baseWorld({ dropCount: 2 }), TTS_STEP, { ...ENV, VOICEMAIL_DROP_DAILY_CAP: "3" } as never);
    expect(outcome.status).toBe("voicemail_queued");
  });

  it("over-long script pauses step_misconfigured", async () => {
    const { outcome } = await run(baseWorld(), { ...TTS_STEP, vm_tts_body: "x".repeat(1201) });
    expect(outcome).toMatchObject({ status: "paused", reason: "step_misconfigured" });
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });

  it("missing phone line pauses step_misconfigured", async () => {
    const { outcome } = await run(baseWorld(), { ...TTS_STEP, vm_phone_line_id: null });
    expect(outcome).toMatchObject({ status: "paused", reason: "step_misconfigured" });
  });

  it("an eligibility read error fails closed and retries later", async () => {
    const { outcome, ops } = await run(baseWorld({ readError: "call_activities" }));
    expect(outcome.status).toBe("failed");
    expect(updatesTo(ops, "sequence_step_runs")[0]).toMatchObject({ claim_active: false, attempt_outcome: "not_attempted" });
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });
});

describe("voicemail drop step — eligibility (RVM-2 / RVM-3)", () => {
  const notSpoken = { calls: [], attempts: [], attemptCalls: [], inbound: [], norma: [], normaInbound: [] };

  it.each([
    ["never spoken to", { ...notSpoken }, "not_spoken_to"],
    ["do_not_contact", { contact: { ...baseWorld().contact, do_not_contact: true } }, "do_not_contact"],
    ["opted out", { contact: { ...baseWorld().contact, sms_opted_out: true } }, "opted_out"],
    [
      "landline only",
      { contact: { ...baseWorld().contact, phone_1_type: "landline", phone_2: null } },
      "no_phone",
    ],
    ["contact missing", { contact: null }, "contact_missing"],
    [
      "reached attempt for a different contact",
      { ...notSpoken, attempts: [{ call_activity_id: "ca-9", occurred_at: "2026-10-01T00:00:00Z" }], attemptCalls: [] },
      "not_spoken_to",
    ],
  ])("%s → skipped not_eligible and advances", async (_label, over, reason) => {
    const { outcome, ops } = await run(baseWorld(over as Partial<World>));
    expect(outcome).toEqual({ status: "skipped_not_eligible", enrollmentId: "enr-1", stepIndex: 0, reason });
    expect(updatesTo(ops, "sequence_step_runs")[0]).toMatchObject({ skipped_reason: "not_eligible", attempt_outcome: "not_attempted" });
    expect(updatesTo(ops, "sequence_enrollments")[0]).toMatchObject({ current_step_index: 1 });
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });

  it("a reached acquisition attempt tied to this contact qualifies and uses that call's phone", async () => {
    await run(
      baseWorld({
        ...notSpoken,
        attempts: [{ call_activity_id: "ca-1", occurred_at: "2026-10-02T00:00:00Z" }],
        attemptCalls: [{ id: "ca-1", phone_e164: "+18165550102" }],
      }),
    );
    expect(getMockVoicemailDropLog()[0].input.to).toBe("+18165550102");
  });

  it("an inbound text qualifies and uses the sending phone", async () => {
    await run(baseWorld({ ...notSpoken, inbound: [{ from_address: "+18165550102", created_at: "2026-10-03T00:00:00Z" }] }));
    expect(getMockVoicemailDropLog()[0].input.to).toBe("+18165550102");
  });

  it("an answered Norma call qualifies", async () => {
    await run(baseWorld({ ...notSpoken, norma: [{ phone_e164: "+18165550101", completed_at: "2026-10-03T00:00:00Z" }] }));
    expect(getMockVoicemailDropLog()[0].input.to).toBe("+18165550101");
  });

  it("an inbound call to Norma from a saved phone qualifies; from an unknown phone does not", async () => {
    await run(baseWorld({ ...notSpoken, normaInbound: [{ from_e164: "+18165550102", created_at: "2026-10-03T00:00:00Z" }] }));
    expect(getMockVoicemailDropLog()).toHaveLength(1);
    resetMockVoicemailDropState();
    const { outcome } = await run(
      baseWorld({ ...notSpoken, normaInbound: [{ from_e164: "+19995550000", created_at: "2026-10-03T00:00:00Z" }] }),
    );
    expect(outcome.status).toBe("skipped_not_eligible");
  });

  it("only queries Norma outcomes where a person answered", async () => {
    const { ops } = await run(baseWorld());
    const norma = ops.find((o) => o.table === "norma_call_requests")!;
    expect(norma.filters).toContainEqual(["in", "outcome", ["callback_requested", "reached_no_callback", "not_interested"]]);
  });

  it("falls back to the primary mobile slot when the event phone is no longer saved", async () => {
    await run(baseWorld({ calls: [{ phone_e164: "+19995550000", started_at: "2026-10-01T00:00:00Z" }] }));
    expect(getMockVoicemailDropLog()[0].input.to).toBe("+18165550102");
  });

  it("uses the most recent qualifying event's phone", async () => {
    await run(
      baseWorld({
        calls: [{ phone_e164: "+18165550101", started_at: "2026-10-01T00:00:00Z" }],
        inbound: [{ from_address: "+18165550102", created_at: "2026-10-05T00:00:00Z" }],
      }),
    );
    expect(getMockVoicemailDropLog()[0].input.to).toBe("+18165550102");
  });

  it("does not use connected_human or voice consent", async () => {
    const { ops } = await run(baseWorld());
    const calls = ops.find((o) => o.table === "call_activities")!;
    expect(calls.filters).toContainEqual(["gt", "talk_duration_seconds", 0]);
    expect(calls.filters.some(([, c]) => c === "outcome")).toBe(false);
    expect(ops.some((o) => o.table === "consent_events")).toBe(false);
  });
});

describe("voicemail drop helpers", () => {
  it("renders deterministically", () => {
    const vars = { first_name: "Pat", property_address: "12 Elm St" };
    const a = renderVoicemailScript(TTS_STEP.vm_tts_body ?? "", vars);
    expect(a).toBe("Hi Pat, it's Norma about 12 Elm St. Call me back.");
    expect(renderVoicemailScript(TTS_STEP.vm_tts_body ?? "", vars)).toBe(a);
    expect(renderVoicemailScript("Hi {{first_name | there}}", {})).toBe("Hi there");
  });

  it("normalizes phones, cap env and callback url", () => {
    expect(toE164("816.555.0101")).toBe("+18165550101");
    expect(toE164("12345")).toBeNull();
    expect(readDailyCap({ VOICEMAIL_DROP_DAILY_CAP: "50" } as never)).toBe(50);
    expect(readDailyCap({} as never)).toBeNull();
    expect(readDailyCap({ VOICEMAIL_DROP_DAILY_CAP: "abc" } as never)).toBeNull();
    expect(voicemailDropCallbackUrl({} as never)).toBeNull();
  });

  it("computes the Chicago day window", () => {
    const { start, next } = chicagoDayWindow(new Date("2026-10-20T03:00:00Z")); // 22:00 CDT Oct 19
    expect(start.toISOString()).toBe("2026-10-19T05:00:00.000Z");
    expect(next.toISOString()).toBe("2026-10-20T05:00:00.000Z");
  });
});

describe("processEnrollmentTick dispatch", () => {
  it("routes send_voicemail_drop steps to the drop branch", async () => {
    vi.stubEnv("VOICEMAIL_DROP_PROVIDER", "");
    const world = baseWorld();
    const { client: inner, ops } = makeClient(world);
    const innerFrom = (inner as unknown as { from: (t: string) => unknown }).from;
    const from = vi.fn((table: string) => {
      if (table === "sequence_steps" && !ops.some((o) => o.table === "sequence_steps")) {
        ops.push({ table, kind: "select", filters: [] });
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () => Promise.resolve({ data: { ...TTS_STEP, action_type: "send_voicemail_drop", template_body: null, template_id: null, template_category: null, target_status: null, delay_after_previous_minutes: 0 }, error: null });
        return b;
      }
      if (table === "properties" && !ops.some((o) => o.table === "properties")) {
        ops.push({ table, kind: "select", filters: [] });
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () => Promise.resolve({ data: { status: "lead", state: "MO", address: "x", outreach_dispo: null, is_dnc_locked: false }, error: null });
        return b;
      }
      return innerFrom(table);
    });
    const outcome = await processEnrollmentTick({ from, rpc: vi.fn() } as never, {
      ...ENROLLMENT,
      enrolled_by_user_id: null,
      status: "active",
    });
    vi.unstubAllEnvs();
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "provider_failed" });
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });
});
