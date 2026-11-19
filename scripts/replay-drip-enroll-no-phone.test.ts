import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enrollNineDrip: vi.fn(),
  enrollNurtureInDrip: vi.fn(),
  loadNurtureAutoDripConfig: vi.fn(),
  recordLeadEvent: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../src/lib/ai-responder/nine-questions-engine", () => ({ enrollNineDrip: h.enrollNineDrip }));
vi.mock("../src/lib/ai-responder/nurture-auto-drip", () => ({
  enrollNurtureInDrip: h.enrollNurtureInDrip,
  loadNurtureAutoDripConfig: h.loadNurtureAutoDripConfig,
  NURTURE_FIRST_SEND_DELAY_DAYS: { one_to_six_months: 30, six_to_twelve_months: 180, check_in_60: 60, listed_not_selling: 14 },
}));
vi.mock("../src/lib/events", () => ({ recordLeadEvent: h.recordLeadEvent }));
vi.mock("../src/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { apply, staleReason, type Fence, type Plan } from "./replay-drip-enroll-no-phone";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const FENCE: Fence = { inboundAt: "2026-10-28T15:00:00Z", ownOutboundId: "out-own", failedAt: "2026-10-28T15:00:01Z" };
const PLAN: Exclude<Plan, { kind: "skip" }> = {
  kind: "nine", fence: FENCE, contactId: "contact-replier", route: "Not interested", drip: "Not interested", skipFirstStep: false,
};

type Filter = [op: string, column: string, value: unknown];
type Call = { table: string; filters: Filter[]; update?: Record<string, unknown>; at: number };

let clock = 0;
/**
 * Fake client. `counts(call)` answers every `head` count (a thrown error comes
 * back as a query error); `maybeSingle` answers per table; updates are recorded
 * and return one row (`armStatus` for the enrolment arm).
 */
function fakeClient(opts: {
  counts: (call: Call) => number | Error;
  property?: Record<string, unknown>;
  armStatus?: string;
}) {
  const calls: Call[] = [];
  const single: Record<string, unknown> = {
    properties: opts.property ?? { needs_human_attention: true, last_ai_escalation_reason: "drip_enroll_failed:no_phone", homeowner_contact_id: null },
    sequence_enrollments: { sequence_id: "seq", current_step_index: 0 },
    sequence_steps: { delay_after_previous_minutes: 2 * 1440 },
  };
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [], at: 0 };
      let head = false;
      const b = {
        select: (_cols?: string, o?: { head?: boolean }) => { head = Boolean(o?.head); return b; },
        update: (row: Record<string, unknown>) => { call.update = row; return b; },
        eq: (c: string, v: unknown) => { call.filters.push(["eq", c, v]); return b; },
        neq: (c: string, v: unknown) => { call.filters.push(["neq", c, v]); return b; },
        gt: (c: string, v: unknown) => { call.filters.push(["gt", c, v]); return b; },
        gte: (c: string, v: unknown) => { call.filters.push(["gte", c, v]); return b; },
        maybeSingle: async () => ({ data: single[table], error: null }),
        then: (resolve: (v: unknown) => void) => {
          call.at = ++clock;
          calls.push(call);
          if (head) {
            const n = opts.counts(call);
            return resolve(n instanceof Error ? { count: null, error: { message: n.message } } : { count: n, error: null });
          }
          const row = table === "sequence_enrollments" && call.update && "next_run_at" in call.update
            ? { status: opts.armStatus ?? "active" }
            : { id: "x" };
          resolve({ data: call.update ? [row] : [], error: null });
        },
      };
      return b;
    },
  };
  return { client, calls };
}

const has = (call: Call, op: string, column: string, value?: unknown) =>
  call.filters.some(([o, c, v]) => o === op && c === column && (value === undefined || v === value));
const updates = (calls: Call[], table: string) => calls.filter((c) => c.table === table && c.update);
const isInbound = (c: Call) => c.table === "messages" && has(c, "eq", "direction", "inbound");

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  h.loadNurtureAutoDripConfig.mockResolvedValue({ enabled: true, sequences: {} });
  h.enrollNineDrip.mockResolvedValue({ status: "enrolled", sequenceId: "seq", enrollmentId: "enr-new" });
});

describe("staleReason", () => {
  it("is fresh when nothing happened since the failure", async () => {
    const { client } = fakeClient({ counts: () => 0 });
    expect(await staleReason(client as never, PROPERTY, FENCE)).toBeNull();
  });

  it("any enrolment since the failure (including a cancelled one) blocks a replay", async () => {
    const { client, calls } = fakeClient({ counts: (c) => (c.table === "sequence_enrollments" ? 1 : 0) });
    expect(await staleReason(client as never, PROPERTY, FENCE)).toMatch(/drip was started \(or cancelled\)/);
    const enr = calls.find((c) => c.table === "sequence_enrollments")!;
    expect(has(enr, "gte", "enrolled_at", FENCE.failedAt)).toBe(true);
    // No status filter: completed/cancelled rows count too.
    expect(enr.filters.some(([, c]) => c === "status")).toBe(false);
  });

  it("ignores only the run's own reply among outbound texts", async () => {
    const { client, calls } = fakeClient({ counts: () => 0 });
    await staleReason(client as never, PROPERTY, FENCE);
    const out = calls.find((c) => c.table === "messages" && has(c, "eq", "direction", "outbound"))!;
    expect(has(out, "neq", "id", "out-own")).toBe(true);
  });
});

describe("apply", () => {
  const YEAR = 365 * 86_400_000;

  it("enrols the replier parked, clears the hold, re-checks, and arms it last", async () => {
    const { client, calls } = fakeClient({ counts: () => 0 });
    const before = Date.now();
    expect(await apply(client as never, PROPERTY, PLAN)).toBe("enrolled; hold cleared");
    const args = h.enrollNineDrip.mock.calls[0]![1] as { contactId: string; firstSendNotBefore: Date };
    expect(args.contactId).toBe("contact-replier");
    expect(args.firstSendNotBefore.getTime() - before).toBeGreaterThan(50 * YEAR);
    const enr = updates(calls, "sequence_enrollments");
    expect(enr).toHaveLength(1);
    const [armCall] = enr;
    // Armed at the later of the step delay (2 days) and the 15-minute floor.
    const runAt = Date.parse(armCall!.update!.next_run_at as string);
    expect(runAt - before).toBeGreaterThanOrEqual(2 * 86_400_000 - 1000);
    expect(has(armCall!, "eq", "id", "enr-new")).toBe(true);
    const clear = updates(calls, "properties")[0]!;
    expect(has(clear, "eq", "last_ai_escalation_reason", "drip_enroll_failed:no_phone")).toBe(true);
    // Armed only after the hold clear and the check that follows it.
    const lastCheck = calls.filter(isInbound).at(-1)!;
    expect(clear.at).toBeLessThan(lastCheck.at);
    expect(lastCheck.at).toBeLessThan(armCall!.at);
  });

  it("a seller reply that lands while enrolling pauses the parked drip and keeps the hold", async () => {
    let enrolled = false;
    h.enrollNineDrip.mockImplementation(async () => { enrolled = true; return { status: "enrolled", sequenceId: "seq", enrollmentId: "enr-new" }; });
    const { client, calls } = fakeClient({ counts: (c) => (enrolled && isInbound(c) ? 1 : 0) });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^enrolled then paused \(seller texted again/);
    const [unpark, pause] = updates(calls, "sequence_enrollments");
    // Un-parked with no status guard (a reply's own pause may have run first), so a later resume can send.
    expect(unpark!.update).toHaveProperty("first_send_not_before");
    expect(unpark!.update).not.toHaveProperty("status");
    expect(unpark!.filters.some(([, c]) => c === "status")).toBe(false);
    expect(pause!.update).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
    expect(updates(calls, "sequence_enrollments").some((c) => "next_run_at" in c.update!)).toBe(false);
    expect(updates(calls, "properties")).toHaveLength(0);
  });

  it("a failed check after enrolling leaves the drip parked and the hold set (fails closed)", async () => {
    let enrolled = false;
    h.enrollNineDrip.mockImplementation(async () => { enrolled = true; return { status: "enrolled", sequenceId: "seq", enrollmentId: "enr-new" }; });
    const { client, calls } = fakeClient({ counts: (c) => (enrolled && isInbound(c) ? new Error("db down") : 0) });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^ENROLLED BUT LEFT PARKED \(db down\)/);
    // Never armed: no update sets a real next_run_at; the hold is never cleared.
    expect(updates(calls, "sequence_enrollments").some((c) => "next_run_at" in c.update!)).toBe(false);
    expect(updates(calls, "properties").some((c) => c.update!.needs_human_attention === false)).toBe(false);
  });

  it("a reply whose pause lands after the last check: the drip stays paused and is un-parked for a resume", async () => {
    const { client, calls } = fakeClient({ counts: () => 0, armStatus: "paused" });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^enrolled, paused meanwhile; hold cleared/);
    const unpark = updates(calls, "sequence_enrollments").at(-2)!;
    expect(unpark.update).toHaveProperty("first_send_not_before");
    expect(unpark.filters.some(([, c]) => c === "status")).toBe(false);
  });

  it("a failed check after clearing the hold never arms the drip and puts the hold back", async () => {
    const { client, calls } = fakeClient({
      counts: (c) => (isInbound(c) && updates(calls, "properties").length > 0 ? new Error("connection lost") : 0),
    });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^ENROLLED BUT LEFT PARKED \(freshness unreadable after clearing: connection lost\)/);
    expect(updates(calls, "sequence_enrollments").some((c) => "next_run_at" in c.update!)).toBe(false);
    expect(updates(calls, "properties").at(-1)!.update).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "drip_enroll_failed:no_phone" });
  });

  it("a reply that slipped in before the hold was cleared gets the hold back and the drip paused", async () => {
    const { client, calls } = fakeClient({
      counts: (c) => (isInbound(c) && updates(calls, "properties").length > 0 ? 1 : 0),
    });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^ENROLLED BUT LEFT PARKED \(seller texted again.*paused; hold set/);
    expect(updates(calls, "sequence_enrollments").some((c) => "next_run_at" in c.update!)).toBe(false);
    const [clear, restore] = updates(calls, "properties");
    expect(clear!.update).toMatchObject({ needs_human_attention: false });
    expect(restore!.update).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "drip_enroll_failed:no_phone" });
    expect(updates(calls, "sequence_enrollments").at(-1)!.update).toMatchObject({ status: "paused" });
  });

  it("the post-enrol check does not count the run's own new enrolment", async () => {
    let enrolled = false;
    h.enrollNineDrip.mockImplementation(async () => { enrolled = true; return { status: "enrolled", sequenceId: "seq", enrollmentId: "enr-new" }; });
    const { client } = fakeClient({ counts: (c) => (enrolled && c.table === "sequence_enrollments" && !has(c, "neq", "id", "enr-new") ? 1 : 0) });
    expect(await apply(client as never, PROPERTY, PLAN)).toBe("enrolled; hold cleared");
  });

  it("a drip cancelled after an earlier replay is never restarted", async () => {
    const { client } = fakeClient({ counts: (c) => (c.table === "sequence_enrollments" ? 1 : 0) });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^skipped: a drip was started \(or cancelled\)/);
    expect(h.enrollNineDrip).not.toHaveBeenCalled();
  });

  it("a drip that went live meanwhile keeps the hold", async () => {
    h.enrollNineDrip.mockResolvedValueOnce({ status: "already_enrolled", sequenceId: "seq" });
    const { client, calls } = fakeClient({ counts: () => 0 });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^skipped: a drip went live meanwhile/);
    expect(updates(calls, "properties")).toHaveLength(0);
  });
});

describe("entrypoint", () => {
  it("starts with the documented command (server-only imports load)", () => {
    const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/replay-drip-enroll-no-phone.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
    });
    expect(result.stderr).not.toMatch(/server-only|cannot be imported/i);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--apply");
  });
});
