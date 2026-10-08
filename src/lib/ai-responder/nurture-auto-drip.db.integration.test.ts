import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";

// Local-only: needs the local Postgres + API stack. Run with
// `vitest run --config vitest.local-integration.config.ts`.
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    DISPO_SET: "dispo_set",
    SEQUENCE_ENROLLED: "sequence_enrolled",
    SEQUENCE_PAUSED: "sequence_paused",
    SEQUENCE_RESUMED: "sequence_resumed",
  },
  recordLeadEvent: vi.fn(async () => undefined),
  recordLeadEvents: vi.fn(async () => undefined),
}));

import { enrollLead, pausePropertyEnrollments, promotePropertyEnrollmentPauseReason } from "@/lib/sequences/enrollment";
import { enrollNurtureInDrip } from "./nurture-auto-drip";

const db = createTestClient();
let orgId = "";
// The local database is shared with other suites, so this one never resets
// tenant tables: it removes only the rows it created.
const created = { sequences: [] as string[], contacts: [] as string[], properties: [] as string[] };

beforeEach(async () => {
  orgId = await getCanonicalTestOrgId(db);
});

afterAll(async () => {
  if (created.properties.length) {
    await db.from("sequence_enrollments").delete().in("property_id", created.properties);
    await db.from("lead_events").delete().in("property_id", created.properties);
    await db.from("properties").delete().in("id", created.properties);
  }
  if (created.contacts.length) await db.from("contacts").delete().in("id", created.contacts);
  if (created.sequences.length) {
    await db.from("sequence_steps").delete().in("sequence_id", created.sequences);
    await db.from("sequences").delete().in("id", created.sequences);
  }
});

async function seedSequence(opts: { active?: boolean; delayMinutes?: number } = {}) {
  const { data: sequence, error } = await db.from("sequences")
    .insert({ org_id: orgId, name: `Nurture ${randomUUID()}`, active: opts.active ?? true }).select("id").single();
  if (error || !sequence) throw error ?? new Error("sequence seed failed");
  created.sequences.push(sequence.id);
  const { error: stepError } = await db.from("sequence_steps").insert({
    sequence_id: sequence.id, step_index: 0, delay_after_previous_minutes: opts.delayMinutes ?? 0,
    action_type: "send_sms", template_body: "Hello there",
  });
  if (stepError) throw stepError;
  return sequence.id;
}

let phoneSeq = Math.floor(Math.random() * 5000);
const uniquePhone = () => `+1816${String(5550000 + (phoneSeq++ % 4_000_000)).padStart(7, "0")}`;

async function seedProperty(label: string, opts: { dispo?: string | null; phone?: string | null; optedOut?: boolean } = {}) {
  const { data: contact, error: contactError } = await db.from("contacts")
    .insert({
      first_name: label, last_name: "Test",
      ...(opts.phone === null ? {} : { phone_1: opts.phone ?? uniquePhone(), phone_1_type: "mobile" }),
      ...(opts.optedOut ? { sms_opted_out: true } : {}),
    })
    .select("id").single();
  if (contactError || !contact) throw contactError ?? new Error("contact seed failed");
  created.contacts.push(contact.id);
  const { data: property, error: propertyError } = await db.from("properties")
    .insert({
      address: `1 ${label} Ln`, state: "MO", status: "new_lead", homeowner_contact_id: contact.id,
      outreach_dispo: opts.dispo === undefined ? "nurture" : opts.dispo,
    })
    .select("id").single();
  if (propertyError || !property) throw propertyError ?? new Error("property seed failed");
  created.properties.push(property.id);
  return property.id;
}

async function dispo(propertyId: string) {
  const { data, error } = await db.from("properties").select("outreach_dispo").eq("id", propertyId).single();
  if (error || !data) throw error ?? new Error("read failed");
  return data.outreach_dispo;
}

async function enrollments(propertyId: string) {
  const { data, error } = await db.from("sequence_enrollments")
    .select("id, sequence_id, status, next_run_at, enrolled_at").eq("property_id", propertyId);
  if (error) throw error;
  return data ?? [];
}

describe("enrollNurtureInDrip (real database, real enrollLead)", () => {
  it("releases nurture to needs_sequence and enrols once in the configured drip", async () => {
    const sequenceId = await seedSequence();
    const propertyId = await seedProperty("Happy");

    const result = await enrollNurtureInDrip(db, { propertyId, sequenceId });

    expect(result).toMatchObject({ status: "enrolled", sequenceId });
    expect(await dispo(propertyId)).toBe("needs_sequence");
    const rows = await enrollments(propertyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence_id: sequenceId, status: "active" });
  });

  it("first-step timing is the drip's own schedule (no extra gap after the nurture reply): a delay-0 first step is due immediately, a 2-day delay is due in 2 days", async () => {
    const immediate = await seedSequence({ delayMinutes: 0 });
    const slow = await seedSequence({ delayMinutes: 60 * 24 * 2 });
    const a = await seedProperty("Immediate");
    const b = await seedProperty("Slow");
    const before = Date.now();

    await enrollNurtureInDrip(db, { propertyId: a, sequenceId: immediate });
    await enrollNurtureInDrip(db, { propertyId: b, sequenceId: slow });

    const [rowA] = await enrollments(a);
    const [rowB] = await enrollments(b);
    expect(new Date(rowA!.next_run_at!).getTime() - before).toBeLessThan(60_000);
    const twoDays = 2 * 24 * 3600_000;
    expect(Math.abs(new Date(rowB!.next_run_at!).getTime() - (before + twoDays))).toBeLessThan(60_000);
  });

  it("is idempotent: a replay (and two racing calls) leave exactly one enrolment", async () => {
    const sequenceId = await seedSequence();
    const propertyId = await seedProperty("Replay");

    const first = await enrollNurtureInDrip(db, { propertyId, sequenceId });
    const second = await enrollNurtureInDrip(db, { propertyId, sequenceId });
    expect(first.status).toBe("enrolled");
    expect(second).toEqual({ status: "already_enrolled", sequenceId });
    expect(await enrollments(propertyId)).toHaveLength(1);
    expect(await dispo(propertyId)).toBe("needs_sequence");

    const racing = await seedProperty("Race");
    const results = await Promise.all([
      enrollNurtureInDrip(db, { propertyId: racing, sequenceId }),
      enrollNurtureInDrip(db, { propertyId: racing, sequenceId }),
    ]);
    expect(await enrollments(racing)).toHaveLength(1);
    expect(results.filter((r) => r.status === "enrolled")).toHaveLength(1);
    expect(await dispo(racing)).toBe("needs_sequence");
  });

  it("matches what the human path enrols: same enrollLead result shape", async () => {
    const sequenceId = await seedSequence();
    const human = await seedProperty("Human", { dispo: "needs_sequence" });
    const auto = await seedProperty("Auto");
    const h = await enrollLead(db, { propertyId: human, sequenceId, enrolledByUserId: null });
    const a = await enrollNurtureInDrip(db, { propertyId: auto, sequenceId });
    expect(h.status).toBe("enrolled");
    expect(a.status).toBe("enrolled");
    const [hr] = await enrollments(human);
    const [ar] = await enrollments(auto);
    expect(ar).toMatchObject({ status: hr!.status, sequence_id: hr!.sequence_id });
  });

  for (const [name, seed, reason] of [
    ["the contact opted out of SMS", () => seedProperty("OptedOut", { optedOut: true }), /no_consent|suppressed/],
    ["the lead has no phone", () => seedProperty("NoPhone", { phone: null }), /no_phone|suppressed/],
  ] as Array<[string, () => Promise<string>, RegExp]>) {
    it(`refuses when ${name}: lead stays nurture, nothing enrolled`, async () => {
      const sequenceId = await seedSequence();
      const propertyId = await seed();
      const result = await enrollNurtureInDrip(db, { propertyId, sequenceId });
      expect(result.status).toBe("refused");
      expect((result as { reason: string }).reason).toMatch(reason);
      expect(await dispo(propertyId)).toBe("nurture");
      expect(await enrollments(propertyId)).toEqual([]);
    });
  }

  it("refuses an inactive drip and leaves the lead as nurture", async () => {
    const sequenceId = await seedSequence({ active: false });
    const propertyId = await seedProperty("Inactive");
    expect(await enrollNurtureInDrip(db, { propertyId, sequenceId })).toEqual({ status: "refused", reason: "sequence_inactive" });
    expect(await dispo(propertyId)).toBe("nurture");
    expect(await enrollments(propertyId)).toEqual([]);
  });

  it("refuses with no configured drip and writes nothing", async () => {
    const propertyId = await seedProperty("NoDrip");
    expect(await enrollNurtureInDrip(db, { propertyId, sequenceId: null })).toEqual({ status: "refused", reason: "no_drip_configured" });
    expect(await dispo(propertyId)).toBe("nurture");
  });

  it("never overwrites a more specific outcome set meanwhile", async () => {
    const sequenceId = await seedSequence();
    const propertyId = await seedProperty("Changed", { dispo: "not_interested" });
    expect(await enrollNurtureInDrip(db, { propertyId, sequenceId })).toEqual({ status: "refused", reason: "outcome_changed" });
    expect(await dispo(propertyId)).toBe("not_interested");
    expect(await enrollments(propertyId)).toEqual([]);
  });

  it("already in a different drip: refused, lead stays nurture, the existing enrolment is untouched", async () => {
    const other = await seedSequence();
    const target = await seedSequence();
    const propertyId = await seedProperty("Busy", { dispo: "needs_sequence" });
    expect((await enrollLead(db, { propertyId, sequenceId: other, enrolledByUserId: null })).status).toBe("enrolled");
    await db.from("properties").update({ outreach_dispo: "nurture" }).eq("id", propertyId);

    const result = await enrollNurtureInDrip(db, { propertyId, sequenceId: target });

    expect(result).toEqual({ status: "refused", reason: "already_in_drip" });
    expect(await dispo(propertyId)).toBe("nurture");
    const rows = await enrollments(propertyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sequence_id).toBe(other);
  });
  it("delayDays holds the first text back: a 30-day route is due in 30 days even when the drip's own first step is immediate", async () => {
    const sequenceId = await seedSequence({ delayMinutes: 0 });
    const propertyId = await seedProperty("Delayed");
    const before = Date.now();
    const result = await enrollNurtureInDrip(db, { propertyId, sequenceId, delayDays: 30 });
    expect(result.status).toBe("enrolled");
    const [row] = await enrollments(propertyId);
    expect(Math.abs(new Date(row!.next_run_at!).getTime() - (before + 30 * 86_400_000))).toBeLessThan(60_000);
  });

  it("a paused enrolment in the same drip is handed back to a person (drip_paused), not left silent", async () => {
    const sequenceId = await seedSequence();
    const propertyId = await seedProperty("Paused");
    expect((await enrollNurtureInDrip(db, { propertyId, sequenceId })).status).toBe("enrolled");
    await pausePropertyEnrollments(db, { propertyId, reason: "inbound_reply" });
    expect(await dispo(propertyId)).toBe("needs_sequence");

    const result = await enrollNurtureInDrip(db, { propertyId, sequenceId });

    expect(result).toEqual({ status: "refused", reason: "drip_paused" });
    expect(await dispo(propertyId)).toBe("nurture");
    expect((await enrollments(propertyId))[0]).toMatchObject({ status: "paused" });
  });
});

describe("Book appointment enrolment (hot lead) stops on its own", () => {
  async function hotEnrol(label: string) {
    const sequenceId = await seedSequence({ delayMinutes: 24 * 60 });
    // A hot lead is NOT nurture (no dispo is set); enrolment is the same shared enrollLead, no offset.
    const propertyId = await seedProperty(label, { dispo: null });
    const outcome = await enrollLead(db, { propertyId, sequenceId, enrolledByUserId: null });
    expect(outcome.status).toBe("enrolled");
    return { sequenceId, propertyId };
  }

  it("follows the drip's own day-1 delay (no extra offset)", async () => {
    const before = Date.now();
    const { propertyId } = await hotEnrol("HotDelay");
    const [row] = await enrollments(propertyId);
    expect(Math.abs(new Date(row!.next_run_at!).getTime() - (before + 24 * 3600_000))).toBeLessThan(60_000);
  });

  it("pauses when the seller replies (inbound reply path)", async () => {
    const { propertyId } = await hotEnrol("HotReply");
    await pausePropertyEnrollments(db, { propertyId, reason: "inbound_reply" });
    expect((await enrollments(propertyId))[0]).toMatchObject({ status: "paused" });
  });

  it("stays paused with the precise reason when a person takes over by text", async () => {
    const { propertyId } = await hotEnrol("HotTakeover");
    await pausePropertyEnrollments(db, { propertyId, reason: "inbound_reply" });
    await promotePropertyEnrollmentPauseReason(db, { propertyId, fromReason: "inbound_reply", reason: "rep_sms_human_takeover" });
    const { data } = await db.from("sequence_enrollments").select("status, pause_reason").eq("property_id", propertyId).single();
    expect(data).toEqual({ status: "paused", pause_reason: "rep_sms_human_takeover" });
  });

  it("pauses when a person starts a call", async () => {
    const { propertyId } = await hotEnrol("HotCall");
    await pausePropertyEnrollments(db, { propertyId, reason: "call_in_progress" });
    expect((await enrollments(propertyId))[0]).toMatchObject({ status: "paused" });
  });
});
