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
import {
  MAX_CONSECUTIVE_NOT_QUEUED,
  processVoicemailDropStep,
  renderVoicemailScript,
  voicemailDropCallbackUrl,
} from "./voicemail-drop-step";

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
  registry: Record<string, unknown>[];
  /** Registry rows appear only from this registry query on (1-based). */
  registryFromCall: number;
  wrongNumbers: Record<string, unknown>[];
  runHistory: Record<string, unknown>[];
  reserveError: { message: string } | null;
  auth: { authorized: boolean; reason: string | null; attempt_outcome: string } | null;
  authError: { message: string } | null;
  readError: string | null;
  failUpdate: string | null;
  /** record_voicemail_drop_accepted / _unknown results (default advanced / held). */
  acceptedResult?: string | null;
  unknownResult?: string | null;
  recordError?: { message: string } | null;
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
    registry: [],
    registryFromCall: 1,
    wrongNumbers: [],
    runHistory: [],
    reserveError: null,
    auth: { authorized: true, reason: null, attempt_outcome: "unknown" },
    authError: null,
    readError: null,
    failUpdate: null,
    ...over,
  };
}

function makeClient(world: World) {
  const ops: Op[] = [];
  let registryCalls = 0;
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
        if (op.filters.some(([, c, v]) => c === "outcome" && v === "wrong_number")) {
          return { data: world.wrongNumbers, error: null };
        }
        return { data: world.norma, error: null };
      case "global_phone_dnc_registry":
        registryCalls += 1;
        return { data: registryCalls >= world.registryFromCall ? world.registry : [], error: null };
      case "sequence_step_runs":
        return { data: world.runHistory, error: null };
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
    for (const name of ["eq", "neq", "in", "gt", "gte", "not", "order", "limit"]) b[name] = filter(name);
    b.maybeSingle = () => Promise.resolve(resolve(op));
    b.single = () => Promise.resolve(resolve(op));
    b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(op)).then(ok, fail);
    return b;
  });
  const rpc = vi.fn((name: string, args: unknown) => {
    ops.push({ table: name, kind: "rpc", payload: args, filters: [] });
    if (name === "record_voicemail_drop_accepted" || name === "record_voicemail_drop_unknown") {
      if (world.recordError) return Promise.resolve({ data: null, error: world.recordError });
      const result = name === "record_voicemail_drop_accepted" ? world.acceptedResult : world.unknownResult;
      return Promise.resolve({ data: result === undefined ? (name === "record_voicemail_drop_accepted" ? "advanced" : "held") : result, error: null });
    }
    if (name === "reserve_voicemail_drop_with_cap") {
      if (world.reserveError) return Promise.resolve({ data: null, error: world.reserveError });
      const cap = (args as { p_cap: number }).p_cap;
      return Promise.resolve({ data: world.dropCount >= cap ? null : "drop-1", error: null });
    }
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
  it("records the 202 in one RPC; a status event that already settled it is still a success", async () => {
    const { outcome, ops } = await run(baseWorld({ acceptedResult: "already_settled" }));
    expect(outcome.status).toBe("voicemail_queued");
    expect(updatesTo(ops, "voicemail_drops")).toHaveLength(0);
    expect(updatesTo(ops, "sequence_enrollments")).toHaveLength(0);
  });

  it("a failed 202 record reports failed and writes nothing else (the run stays unknown)", async () => {
    for (const world of [baseWorld({ recordError: { message: "boom" } }), baseWorld({ acceptedResult: "run_changed" })]) {
      const { outcome, ops } = await run(world);
      expect(outcome.status).toBe("failed");
      expect(updatesTo(ops, "sequence_enrollments")).toHaveLength(0);
      expect(updatesTo(ops, "sequence_step_runs")).toHaveLength(0);
    }
  });

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
      brandId: null,
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
    const auth = ops.find((o) => o.kind === "rpc" && o.table === "authorize_sequence_provider_attempt")!;
    expect(auth.table).toBe("authorize_sequence_provider_attempt");
    expect(auth.payload).toMatchObject({ p_claim_id: CLAIM, p_phone: "+18165550101", p_message_id: null });

    const record = ops.find((o) => o.kind === "rpc" && o.table === "record_voicemail_drop_accepted")!;
    expect(record.payload).toEqual({ p_run_id: CLAIM, p_drop_row_id: "drop-1", p_payload: { status: "queued" } });
    // Run, drop and enrollment are written inside the RPC, never directly.
    expect(updatesTo(ops, "voicemail_drops")).toHaveLength(0);
    expect(updatesTo(ops, "sequence_step_runs")).toHaveLength(0);
    expect(updatesTo(ops, "sequence_enrollments")).toHaveLength(0);
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

  it(`${MAX_CONSECUTIVE_NOT_QUEUED} consecutive not-queued runs pause provider_failed and report`, async () => {
    expect(MAX_CONSECUTIVE_NOT_QUEUED).toBe(12);
    setMockVoicemailDropResult({ outcome: "not_queued", httpStatus: 429, raw: {} });
    const history = Array.from({ length: 12 }, () => ({ recovery_action: "voicemail_drop_not_queued_retry" }));
    const { outcome, ops } = await run(baseWorld({ runHistory: history }));
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "provider_failed" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(updatesTo(ops, "sequence_enrollments")[0]).toMatchObject({ status: "paused", pause_reason: "provider_failed" });
    const streakRead = ops.find((o) => o.table === "sequence_step_runs" && o.kind === "select")!;
    expect(streakRead.filters).toContainEqual(["eq", "step_id", "step-1"]);
    expect(streakRead.filters).toContainEqual(["eq", "enrollment_id", "enr-1"]);
  });

  it("an interrupted streak (11 not-queued, then another outcome) keeps retrying", async () => {
    setMockVoicemailDropResult({ outcome: "not_queued", httpStatus: 500, raw: {} });
    const history = [
      ...Array.from({ length: 11 }, () => ({ recovery_action: "voicemail_drop_not_queued_retry" })),
      { recovery_action: "quiet_hours_deferred" },
    ];
    const { outcome } = await run(baseWorld({ runHistory: history }));
    expect(outcome.status).toBe("rescheduled_provider_not_queued");
    expect(reportError).not.toHaveBeenCalled();
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
    const record = ops.find((o) => o.kind === "rpc" && o.table === "record_voicemail_drop_unknown")!;
    expect(record.payload).toMatchObject({ p_run_id: CLAIM, p_drop_row_id: "drop-1" });
    expect(String((record.payload as { p_reason: string }).p_reason)).toContain(cause);
    expect(updatesTo(ops, "sequence_step_runs")).toHaveLength(0);
    expect(updatesTo(ops, "sequence_enrollments")).toHaveLength(0);
  });

  it("unknown after a status event already reconciled the drop: success, nothing re-paused", async () => {
    setMockVoicemailDropResult({ outcome: "unknown", httpStatus: null, cause: "timeout", raw: null });
    const { outcome, ops } = await run(baseWorld({ unknownResult: "already_reconciled" }));
    expect(outcome).toEqual({ status: "voicemail_queued", enrollmentId: "enr-1", stepIndex: 0, dropId: "drop-1" });
    expect(updatesTo(ops, "sequence_enrollments")).toHaveLength(0);
  });

  it("unknown with a run that changed, or an RPC error: failed, no direct writes", async () => {
    setMockVoicemailDropResult({ outcome: "unknown", httpStatus: null, cause: "timeout", raw: null });
    for (const world of [baseWorld({ unknownResult: "run_changed" }), baseWorld({ recordError: { message: "boom" } })]) {
      const { outcome, ops } = await run(world);
      expect(outcome.status).toBe("failed");
      expect(updatesTo(ops, "sequence_enrollments")).toHaveLength(0);
    }
  });

  it("a thrown provider error is treated as unknown, never re-fired", async () => {
    const { client, ops } = makeClient(baseWorld());
    const env = { ...ENV, VOICEMAIL_DROP_PROVIDER: "mock" } as NodeJS.ProcessEnv;
    const { MockVoicemailDropProvider } = await import("@/lib/voicemail-drop/providers/mock");
    const spy = vi.spyOn(MockVoicemailDropProvider.prototype, "sendDrop").mockRejectedValueOnce(new Error("socket hang up"));
    const outcome = await processVoicemailDropStep(client, ENROLLMENT, TTS_STEP, { state: "MO" }, CLAIM, env);
    spy.mockRestore();
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "reconciliation_required" });
    expect(ops.some((o) => o.kind === "rpc" && o.table === "record_voicemail_drop_unknown")).toBe(true);
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

  it("with a cap, count + insert go through the locked reserve RPC (no direct insert)", async () => {
    const { outcome, ops } = await run(baseWorld({ dropCount: 2 }), TTS_STEP, { ...ENV, VOICEMAIL_DROP_DAILY_CAP: "3" } as never);
    expect(outcome.status).toBe("voicemail_queued");
    const reserve = ops.find((o) => o.kind === "rpc" && o.table === "reserve_voicemail_drop_with_cap")!;
    expect(reserve.payload).toMatchObject({
      p_org_id: "org-1",
      p_cap: 3,
      p_since: chicagoDayWindow(new Date()).start.toISOString(),
      p_step_run_id: CLAIM,
      p_to_phone: "+18165550101",
      p_audio_kind: "tts",
    });
    expect(ops.some((o) => o.table === "voicemail_drops" && o.kind === "insert")).toBe(false);
    expect(getMockVoicemailDropLog()[0].input.foreignId).toBe("drop-1");
  });

  it("a reserve RPC error fails closed and retries in 5 minutes", async () => {
    const before = Date.now();
    const { outcome } = await run(baseWorld({ reserveError: { message: "lock timeout" } }), TTS_STEP, {
      ...ENV,
      VOICEMAIL_DROP_DAILY_CAP: "3",
    } as never);
    expect(outcome.status).toBe("rescheduled_daily_cap");
    const next = Date.parse((outcome as { nextRunAt: string }).nextRunAt);
    expect(next - before).toBeGreaterThanOrEqual(5 * 60 * 1000 - 50);
    expect(next - before).toBeLessThan(6 * 60 * 1000);
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
    const norma = ops.find(
      (o) => o.table === "norma_call_requests" && o.filters.some(([f, c]) => f === "in" && c === "outcome"),
    )!;
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

describe("voicemail drop step — per-number don't-call checks", () => {
  const rawOnly = { ...baseWorld().contact, phone_1: "8165550101", phone_1_type: "mobile", phone_2: null };

  it("global DNC registry on the only phone (raw 10-digit slot) → not_eligible", async () => {
    const { outcome, ops } = await run(
      baseWorld({ contact: rawOnly, registry: [{ phone_e164: "+18165550101" }] }),
    );
    expect(outcome).toEqual({ status: "skipped_not_eligible", enrollmentId: "enr-1", stepIndex: 0, reason: "global_dnc_registry" });
    const reg = ops.find((o) => o.table === "global_phone_dnc_registry")!;
    expect(reg.filters).toContainEqual(["in", "phone_e164", ["+18165550101"]]);
    expect(reg.filters).toContainEqual(["eq", "org_id", "org-1"]);
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });

  it("Norma wrong_number on the only phone (raw 10-digit slot) → not_eligible", async () => {
    const { outcome, ops } = await run(
      baseWorld({ contact: rawOnly, wrongNumbers: [{ phone_e164: "+18165550101" }] }),
    );
    expect(outcome).toEqual({ status: "skipped_not_eligible", enrollmentId: "enr-1", stepIndex: 0, reason: "wrong_number_flagged" });
    const wrong = ops.find(
      (o) => o.table === "norma_call_requests" && o.filters.some(([, c, v]) => c === "outcome" && v === "wrong_number"),
    )!;
    expect(wrong.filters).toContainEqual(["eq", "status", "completed"]);
    expect(wrong.filters).toContainEqual(["in", "phone_e164", ["+18165550101"]]);
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });

  it("a blocked qualifying-event phone is skipped for another saved phone", async () => {
    await run(baseWorld({ registry: [{ phone_e164: "+18165550101" }] }));
    expect(getMockVoicemailDropLog()[0].input.to).toBe("+18165550102");
  });

  it("the slot fallback never picks a blocked phone", async () => {
    // Event phone no longer saved; the mobile slot is a known wrong number.
    await run(
      baseWorld({
        calls: [{ phone_e164: "+19995550000", started_at: "2026-10-01T00:00:00Z" }],
        wrongNumbers: [{ phone_e164: "+18165550102" }],
      }),
    );
    expect(getMockVoicemailDropLog()[0].input.to).toBe("+18165550101");
  });

  it("a registry entry added after eligibility is caught by the re-check before the provider call", async () => {
    const { outcome, ops } = await run(baseWorld({ registry: [{ phone_e164: "+18165550101" }], registryFromCall: 2 }));
    expect(outcome).toEqual({ status: "skipped_not_eligible", enrollmentId: "enr-1", stepIndex: 0, reason: "global_dnc_registry" });
    expect(ops.filter((o) => o.table === "global_phone_dnc_registry")).toHaveLength(2);
    expect(ops.some((o) => o.table === "authorize_sequence_provider_attempt")).toBe(false);
    expect(ops.some((o) => o.table === "voicemail_drops" && o.kind === "insert")).toBe(false);
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });
});

describe("voicemail drop step — BYOC caller ID", () => {
  const BYOC = { ...ENV, DROPCOWBOY_CALLER_ID: "+18165550199" } as NodeJS.ProcessEnv;

  it("DROPCOWBOY_CALLER_ID set: no phone line needed, sends callerId and no phone line", async () => {
    const { outcome } = await run(baseWorld(), { ...TTS_STEP, vm_phone_line_id: null }, BYOC);
    expect(outcome.status).toBe("voicemail_queued");
    const input = getMockVoicemailDropLog()[0].input;
    expect(input.callerId).toBe("+18165550199");
    expect(input.phoneLineId).toBeNull();
  });

  it("caller ID wins over a step phone line", async () => {
    await run(baseWorld(), TTS_STEP, BYOC);
    expect(getMockVoicemailDropLog()[0].input).toMatchObject({ callerId: "+18165550199", phoneLineId: null });
  });

  it("a non-E.164 DROPCOWBOY_CALLER_ID pauses provider_failed and reports", async () => {
    const { outcome } = await run(baseWorld(), TTS_STEP, { ...ENV, DROPCOWBOY_CALLER_ID: "816-555-0199" } as never);
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "provider_failed" });
    expect(reportError).toHaveBeenCalled();
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });
});

describe("voicemail drop step — merge fields reach Drop Cowboy rendered", () => {
  it("no { or } survives in the tts_body sent to the provider", async () => {
    await run(baseWorld(), {
      ...TTS_STEP,
      vm_tts_body: "Hi {{first_name}}, about {{property_address}}. {{#if first_name}}Talk soon {{first_name | friend}}.{{/if}}",
    });
    const audio = getMockVoicemailDropLog()[0].input.audio as { kind: "tts"; ttsBody: string };
    expect(audio.ttsBody).toBe("Hi Pat, about 12 Elm St. Talk soon Pat.");
    expect(audio.ttsBody).not.toMatch(/[{}]/);
  });

  it.each(["Hi {first_name}, this is Norma.", "Hi {{#if first_name}}Pat"])(
    "an unrendered placeholder (%s) pauses step_misconfigured and sends nothing",
    async (body) => {
      const { outcome } = await run(baseWorld(), { ...TTS_STEP, vm_tts_body: body });
      expect(outcome).toMatchObject({ status: "paused", reason: "step_misconfigured" });
      expect(getMockVoicemailDropLog()).toHaveLength(0);
    },
  );
});

describe("voicemail drop step — Drop Cowboy random variants are blocked", () => {
  it.each(["[Hi/Hello] {{first_name}}, this is Norma.", "Hi {{first_name}}, [call/text] me back."])(
    "random-variant brackets (%s) pause step_misconfigured and send nothing",
    async (body) => {
      const { outcome } = await run(baseWorld(), { ...TTS_STEP, vm_tts_body: body });
      expect(outcome).toMatchObject({ status: "paused", reason: "step_misconfigured" });
      expect(getMockVoicemailDropLog()).toHaveLength(0);
    },
  );

  it("plain brackets without a slash still send", async () => {
    const { outcome } = await run(baseWorld(), { ...TTS_STEP, vm_tts_body: "Hi {{first_name}} [Norma] here." });
    expect(outcome).not.toMatchObject({ status: "paused" });
    expect(getMockVoicemailDropLog()).toHaveLength(1);
  });
});

describe("voicemail drop step — DROPCOWBOY_BRAND_ID", () => {
  it("sends brandId when set, null when unset", async () => {
    await run(baseWorld(), TTS_STEP, { ...ENV, DROPCOWBOY_BRAND_ID: " brand_9 " } as never);
    expect(getMockVoicemailDropLog()[0].input.brandId).toBe("brand_9");
  });

  it("unset brand id sends null", async () => {
    await run(baseWorld(), TTS_STEP);
    expect(getMockVoicemailDropLog()[0].input.brandId).toBeNull();
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
    expect(() => readDailyCap({ VOICEMAIL_DROP_DAILY_CAP: "abc" } as never)).toThrow();
    expect(() => readDailyCap({ VOICEMAIL_DROP_DAILY_CAP: "-5" } as never)).toThrow();
    expect(voicemailDropCallbackUrl({} as never)).toBeNull();
    expect(() => voicemailDropCallbackUrl({ DROPCOWBOY_CALLBACK_SECRET: "s" } as never)).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it.each(["abc", "-5", "2.5"])("invalid daily cap %s fails closed: pauses provider_failed, reports, no drop row", async (cap) => {
    const { outcome, ops } = await run(baseWorld(), TTS_STEP, { ...ENV, VOICEMAIL_DROP_DAILY_CAP: cap } as never);
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "provider_failed" });
    expect(reportError).toHaveBeenCalled();
    expect(ops.some((o) => o.table === "voicemail_drops")).toBe(false);
    expect(getMockVoicemailDropLog()).toHaveLength(0);
  });

  it("missing app URL pauses provider_failed and reports instead of using a hardcoded host", async () => {
    const { NEXT_PUBLIC_APP_URL: _omit, ...noUrl } = ENV as Record<string, string>;
    void _omit;
    const { outcome, ops } = await run(baseWorld(), TTS_STEP, noUrl as never);
    expect(outcome).toEqual({ status: "paused", enrollmentId: "enr-1", reason: "provider_failed" });
    expect(updatesTo(ops, "sequence_step_runs")[0]).toMatchObject({ failure_reason: "voicemail drop callback url missing" });
    expect(reportError).toHaveBeenCalled();
    expect(getMockVoicemailDropLog()).toHaveLength(0);
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
