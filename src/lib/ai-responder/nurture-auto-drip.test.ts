import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enrollLead: vi.fn(),
  config: { data: null as unknown, error: null as { message: string } | null },
  promoted: { data: { id: "p1" } as unknown, error: null as { message: string } | null },
  current: { data: { outreach_dispo: "needs_sequence" } as unknown, error: null as { message: string } | null },
  live: { data: { status: "active" } as unknown, error: null as { message: string } | null },
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { DISPO_SET: "dispo_set" },
  recordLeadEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/sequences/enrollment", () => ({ enrollLead: mocks.enrollLead }));

import { enrollNurtureInDrip, loadNurtureAutoDripConfig, NURTURE_FIRST_SEND_DELAY_DAYS, routeNurture } from "./nurture-auto-drip";

function builder(result: () => unknown, onUpdate?: (v: Record<string, unknown>) => void) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "limit"]) b[m] = () => b;
  b.update = (v: Record<string, unknown>) => {
    onUpdate?.(v);
    return b;
  };
  b.maybeSingle = async () => result();
  b.then = (resolve: (v: unknown) => unknown) => resolve(result());
  return b;
}
const supabase = {
  from: (table: string) =>
    table === "ai_responder_configs"
      ? builder(() => mocks.config)
      : table === "sequence_enrollments"
        ? builder(() => mocks.live)
        : (() => {
          let isUpdate = false;
          const b = builder(() => (isUpdate ? mocks.promoted : mocks.current), (v) => {
            isUpdate = true;
            mocks.updates.push(v);
          });
          return b;
        })(),
} as never;

beforeEach(() => {
  mocks.enrollLead.mockReset();
  mocks.updates = [];
  mocks.promoted = { data: { id: "p1" }, error: null };
  mocks.current = { data: { outreach_dispo: "needs_sequence" }, error: null };
  mocks.live = { data: { status: "active" }, error: null };
});

describe("loadNurtureAutoDripConfig", () => {
  it("is off when there is no row or the flag is false (default)", async () => {
    mocks.config = { data: null, error: null };
    expect(await loadNurtureAutoDripConfig(supabase, "org")).toEqual({ enabled: false });
    mocks.config = { data: { nurture_auto_drip: false, nurture_drip_maybe_later_sequence_id: "s" }, error: null };
    expect(await loadNurtureAutoDripConfig(supabase, "org")).toEqual({ enabled: false });
  });
  it("returns the owner's four mapped drips when on", async () => {
    mocks.config = { data: { nurture_auto_drip: true, nurture_drip_maybe_later_sequence_id: "s1", nurture_drip_check_in_60_sequence_id: "s2", nurture_drip_listed_not_selling_sequence_id: "s3", nurture_drip_hot_book_appointment_sequence_id: "s4" }, error: null };
    expect(await loadNurtureAutoDripConfig(supabase, "org")).toEqual({
      enabled: true,
      sequences: { maybe_later: "s1", check_in_60: "s2", listed_not_selling: "s3", hot_book_appointment: "s4" },
    });
  });
  it("treats an unreadable config as OFF (switch state unknown: no holds), and reports it", async () => {
    mocks.config = { data: null, error: { message: "boom" } };
    expect(await loadNurtureAutoDripConfig(supabase, "org")).toEqual({ enabled: false });
  });
});

describe("routeNurture (Jarrad-approved routing, 2026-10-07)", () => {
  const r = (readyTimeframe: Parameters<typeof routeNurture>[0]["readyTimeframe"], listingStatus: Parameters<typeof routeNurture>[0]["listingStatus"] = "not_listed_or_not_stated") =>
    routeNurture({ readyTimeframe, listingStatus });
  it("pins the confirmed first-send offsets", () => {
    expect(NURTURE_FIRST_SEND_DELAY_DAYS).toEqual({ one_to_six_months: 30, six_to_twelve_months: 180, check_in_60: 60, listed_not_selling: 14 });
  });
  it("within_30_days goes to a person with the Book appointment drip", () => {
    expect(r("within_30_days")).toEqual({ kind: "person", drip: "hot_book_appointment" });
  });
  it("one_to_six_months -> Maybe later +30d; six_to_twelve_months -> Maybe later +180d", () => {
    expect(r("one_to_six_months")).toEqual({ kind: "drip", drip: "maybe_later", delayDays: 30 });
    expect(r("six_to_twelve_months")).toEqual({ kind: "drip", drip: "maybe_later", delayDays: 180 });
  });
  it("over_a_year, not_stated, uncertain and no answer -> Check in every 60 days +60d", () => {
    for (const t of ["over_a_year", "not_stated", "uncertain", null, undefined] as const) {
      expect(r(t)).toEqual({ kind: "drip", drip: "check_in_60", delayDays: 60 });
    }
  });
  it("within_30_days beats listed: still a hot lead for a person", () => {
    expect(r("within_30_days", "listed")).toEqual({ kind: "person", drip: "hot_book_appointment" });
  });
  it("listed beats every other timeframe -> Listed, not selling +14d", () => {
    for (const t of ["one_to_six_months", "over_a_year", "not_stated", null] as const) {
      expect(r(t, "listed")).toEqual({ kind: "drip", drip: "listed_not_selling", delayDays: 14 });
    }
  });
  it("an uncertain listing answer does not count as listed", () => {
    expect(r("one_to_six_months", "uncertain")).toMatchObject({ drip: "maybe_later" });
  });
});

describe("enrollNurtureInDrip", () => {
  it("never enrols without a configured drip", async () => {
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: null })).toEqual({ status: "refused", reason: "no_drip_configured" });
    expect(mocks.enrollLead).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
  });
  it("enrols through the shared enrollLead with the configured drip and no human actor", async () => {
    mocks.enrollLead.mockResolvedValue({ status: "enrolled", enrollmentId: "e1", sequenceLabel: "x" });
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toMatchObject({ status: "enrolled", sequenceId: "s1", enrollmentId: "e1" });
    expect(mocks.enrollLead).toHaveBeenCalledTimes(1);
    expect(mocks.enrollLead).toHaveBeenCalledWith(supabase, { propertyId: "p1", sequenceId: "s1", enrolledByUserId: null, firstSendNotBefore: expect.any(Date) });
  });
  it("the first text is held back by the route's delay (firstSendNotBefore = now + days)", async () => {
    mocks.enrollLead.mockResolvedValue({ status: "enrolled", enrollmentId: "e1", sequenceLabel: "x" });
    const before = Date.now();
    const result = await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1", delayDays: 30 });
    const after = Date.now();
    const passed = (mocks.enrollLead.mock.calls[0]![1] as { firstSendNotBefore: Date }).firstSendNotBefore.getTime();
    expect(passed).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
    expect(passed).toBeLessThanOrEqual(after + 30 * 86_400_000);
    expect(result).toMatchObject({ status: "enrolled", firstSendNotBefore: new Date(passed).toISOString() });
  });
  it("a PAUSED enrolment in the same drip is not 'already enrolled': dispo is handed back and drip_paused is raised", async () => {
    mocks.enrollLead.mockResolvedValue({ status: "duplicate_active" });
    mocks.live = { data: { status: "paused" }, error: null };
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "refused", reason: "drip_paused" });
    expect(mocks.updates.map((u) => u.outreach_dispo)).toEqual(["needs_sequence", "nurture"]);
  });
  it("an ACTIVE enrolment in the same drip is idempotent success and is not reverted", async () => {
    mocks.enrollLead.mockResolvedValue({ status: "duplicate_active" });
    mocks.live = { data: { status: "active" }, error: null };
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "already_enrolled", sequenceId: "s1" });
    expect(mocks.updates.map((u) => u.outreach_dispo)).toEqual(["needs_sequence"]);
  });
  it("a paused same-drip enrolment on a replay (already released) is still handed back to a person", async () => {
    mocks.promoted = { data: null, error: null };
    mocks.enrollLead.mockResolvedValue({ status: "duplicate_active" });
    mocks.live = { data: { status: "paused" }, error: null };
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "refused", reason: "drip_paused" });
    // The promote attempt matched nothing; the hand-back then restores nurture.
    expect(mocks.updates.map((u) => u.outreach_dispo)).toEqual(["needs_sequence", "nurture"]);
  });
  it("a refusal reverts the release and reports the reason", async () => {
    mocks.enrollLead.mockResolvedValue({ status: "no_consent", message: "m" });
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "refused", reason: "no_consent" });
    expect(mocks.updates.map((u) => u.outreach_dispo)).toEqual(["needs_sequence", "nurture"]);
  });
  it("a thrown enrolment is a refusal, never an exception", async () => {
    mocks.enrollLead.mockRejectedValue(new Error("db down"));
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "refused", reason: "enroll_failed" });
    expect(mocks.updates.map((u) => u.outreach_dispo)).toEqual(["needs_sequence", "nurture"]);
  });
  it("a changed outcome is refused without enrolling or reverting anything", async () => {
    mocks.promoted = { data: null, error: null };
    mocks.current = { data: { outreach_dispo: "not_interested" }, error: null };
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "refused", reason: "outcome_changed" });
    expect(mocks.enrollLead).not.toHaveBeenCalled();
  });
  it("a replay on an already-released lead enrols idempotently and does not revert on duplicate", async () => {
    mocks.promoted = { data: null, error: null };
    mocks.enrollLead.mockResolvedValue({ status: "duplicate_active" });
    mocks.live = { data: { status: "active" }, error: null };
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "already_enrolled", sequenceId: "s1" });
  });
});
