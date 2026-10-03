import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { createOrgUser, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

// Local-only: needs Postgres at 127.0.0.1:54329 (designation setup) plus the
// local API stack. Run with `vitest run --config vitest.local-integration.config.ts`.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    DISPO_SET: "dispo_set",
    OPTED_OUT: "opted_out",
    SEQUENCE_ENROLLED: "sequence_enrolled",
    SEQUENCE_PAUSED: "sequence_paused",
    SEQUENCE_RESUMED: "sequence_resumed",
    SEQUENCE_CANCELED: "sequence_canceled",
  },
  recordLeadEvent: vi.fn(async () => undefined),
  recordLeadEvents: vi.fn(async () => undefined),
}));

const testClient = createTestClient();
let actorId = "";

// One-shot failure injection: the next matching write on `table` resolves to
// `{ data: null, error }` instead of reaching the database. No trigger or
// guard is bypassed; the real database still enforces everything else.
type Injection = { table: string; op: "update" | "insert"; message: string };
let injection: Injection | null = null;
function failingBuilder(message: string) {
  const result = { data: null, error: { message } };
  const builder: unknown = new Proxy(function () {}, {
    get: (_target, prop) =>
      prop === "then"
        ? (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject)
        : () => builder,
  });
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const client = Object.create(testClient) as typeof testClient;
    Object.defineProperty(client, "auth", { value: {
      ...testClient.auth,
      getUser: async () => ({ data: { user: { id: actorId } }, error: null }),
    } });
    Object.defineProperty(client, "from", { value: (table: string) => {
      const real = testClient.from(table as never) as unknown as Record<string, unknown>;
      return new Proxy(real, {
        get(target, prop) {
          if (injection && injection.table === table && prop === injection.op) {
            const hit = injection;
            injection = null;
            return () => failingBuilder(hit.message);
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } });
    return client;
  },
}));

import { setInboxDispoAndStartDrip, setOutreachDispo } from "@/app/(dashboard)/messages/dispo-actions";
import { getConsentState } from "@/lib/messaging/consent";
import { evaluateSuppression } from "@/lib/messaging/suppression";
import { completeSoftphoneCall } from "@/lib/dialer/actions";
import { enrollLead } from "@/lib/sequences/enrollment";
import { saveOutreachDispo } from "./outreach-dispo";

async function setAcquisitions(orgId: string, userId: string, enabled: boolean) {
  const url = process.env.TEST_SUPABASE_DB_URL;
  if (!url) throw new Error("Missing TEST_SUPABASE_DB_URL");
  const target = new URL(url);
  if (target.hostname !== "127.0.0.1" || target.port !== "54329") {
    throw new Error("outreach-dispo integration requires local Postgres at 127.0.0.1:54329");
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${userId}:${orgId}:${userId}`]);
    await db.query("update public.memberships set acquisitions_enabled=$3 where user_id=$1 and org_id=$2", [userId, orgId, enabled]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

async function seedSequence() {
  const { data: sequence, error } = await testClient.from("sequences")
    .insert({ org_id: orgId, name: `Optout ${randomUUID()}`, active: true }).select("id").single();
  if (error || !sequence) throw error ?? new Error("sequence seed failed");
  const { error: stepError } = await testClient.from("sequence_steps").insert({
    sequence_id: sequence.id, step_index: 0, delay_after_previous_minutes: 60,
    action_type: "send_sms", template_body: "Hello there",
  });
  if (stepError) throw stepError;
  return sequence.id;
}

async function seedSiblingProperty(contactId: string, label: string) {
  const { data, error } = await testClient.from("properties")
    .insert({ address: `2 ${label} Ln`, state: "MO", status: "new_lead", homeowner_contact_id: contactId })
    .select("id").single();
  if (error || !data) throw error ?? new Error("sibling seed failed");
  return data.id;
}

async function seedConsent(contactId: string, eventType: string, occurredAt: string) {
  const { error } = await testClient.from("consent_events").insert({
    org_id: orgId, contact_id: contactId, channel: "sms", event_type: eventType,
    source: "test", occurred_at: occurredAt,
  });
  if (error) throw error;
}

async function optOutEvents(contactId: string) {
  const { data, error } = await testClient.from("consent_events").select("id, source")
    .eq("contact_id", contactId).eq("channel", "sms").eq("event_type", "opt_out");
  if (error) throw error;
  return data ?? [];
}

async function readContact(contactId: string) {
  const { data, error } = await testClient.from("contacts")
    .select("sms_opted_out, do_not_contact").eq("id", contactId).single();
  if (error || !data) throw error ?? new Error("contact read failed");
  return data;
}

async function readProperty(propertyId: string) {
  const { data, error } = await testClient.from("properties")
    .select("outreach_dispo, is_dnc_locked").eq("id", propertyId).single();
  if (error || !data) throw error ?? new Error("property read failed");
  return data;
}

async function enrollmentStatuses(propertyIds: string[]) {
  const { data, error } = await testClient.from("sequence_enrollments")
    .select("property_id, status").in("property_id", propertyIds);
  if (error) throw error;
  return data ?? [];
}

async function seedProperty(label: string) {
  const { data: contact, error: contactError } = await testClient.from("contacts")
    .insert({ first_name: label, last_name: "Test", phone_1: "+18165550123", phone_1_type: "mobile" })
    .select("id").single();
  if (contactError || !contact) throw contactError ?? new Error("contact seed failed");
  const { data: property, error: propertyError } = await testClient.from("properties")
    .insert({ address: `1 ${label} Ln`, state: "MO", status: "new_lead", homeowner_contact_id: contact.id })
    .select("id").single();
  if (propertyError || !property) throw propertyError ?? new Error("property seed failed");
  return { contactId: contact.id, propertyId: property.id };
}

let orgId = "";
beforeEach(async () => {
  await resetTenantTables(testClient);
  orgId = await getCanonicalTestOrgId(testClient);
  actorId = (await createOrgUser(testClient, {
    orgId, email: `dispo-${randomUUID()}@example.test`, role: "member",
  })).userId;
});

// reset_tenant_tables() cannot re-seed an Acquisitions designation, so always
// leave the acting member un-designated.
afterEach(async () => {
  if (actorId) await setAcquisitions(orgId, actorId, false);
});

describe("server-side Messages workspace gate", () => {
  it("rejects an Acquisitions member on both exported actions and writes nothing", async () => {
    await setAcquisitions(orgId, actorId, true);
    const { propertyId, contactId } = await seedProperty("Gate");
    const { data: sequence } = await testClient.from("sequences")
      .insert({ org_id: orgId, name: `Gate ${randomUUID()}`, active: true }).select("id").single();

    expect(await setOutreachDispo(propertyId, "opted_out"))
      .toEqual({ ok: false, error: "Messages workspace access is unavailable." });
    expect(await setInboxDispoAndStartDrip(propertyId, "needs_sequence", sequence!.id))
      .toEqual({ ok: false, error: "Messages workspace access is unavailable." });

    const { data: property } = await testClient.from("properties")
      .select("outreach_dispo").eq("id", propertyId).single();
    expect(property?.outreach_dispo).toBeNull();
    const { data: contact } = await testClient.from("contacts")
      .select("sms_opted_out").eq("id", contactId).single();
    expect(contact?.sms_opted_out).toBe(false);
    const { data: consent } = await testClient.from("consent_events").select("id").eq("contact_id", contactId);
    expect(consent).toEqual([]);
    const { data: enrollments } = await testClient.from("sequence_enrollments").select("id").eq("property_id", propertyId);
    expect(enrollments).toEqual([]);
  });

  it("still lets the dialer path (shared saver) save for an Acquisitions member", async () => {
    await setAcquisitions(orgId, actorId, true);
    const { propertyId } = await seedProperty("Dialer");

    expect(await saveOutreachDispo(propertyId, "not_interested")).toEqual({ ok: true });

    const { data: property } = await testClient.from("properties")
      .select("outreach_dispo").eq("id", propertyId).single();
    expect(property?.outreach_dispo).toBe("not_interested");
  });
});

describe("opt-out durability (real database)", () => {
  it("DNC: a failed consent insert is retried under the contact lock without mutating the locked row", async () => {
    const sequenceId = await seedSequence();
    const { propertyId, contactId } = await seedProperty("Dnc");
    const siblingId = await seedSiblingProperty(contactId, "DncSibling");
    expect((await enrollLead(testClient, { sequenceId, propertyId, enrolledByUserId: actorId })).status).toBe("enrolled");

    injection = { table: "consent_events", op: "insert", message: "injected consent insert failure" };
    const first = await saveOutreachDispo(propertyId, "dnc");
    expect(first).toEqual({ ok: false, error: "recordConsentEvent: injected consent insert failure", committed: true });
    expect(injection).toBeNull();
    expect((await readProperty(propertyId)).outreach_dispo).toBe("dnc");
    expect(await optOutEvents(contactId)).toHaveLength(0);

    const flagBeforeRetry = (await readContact(contactId)).sms_opted_out;
    expect(await saveOutreachDispo(propertyId, "dnc")).toEqual({ ok: true });

    // The locked contact boolean stays exactly as it was; consent is carried
    // by exactly one opt_out event, and the enrollment is stopped.
    expect((await readContact(contactId)).sms_opted_out).toBe(flagBeforeRetry);
    expect(await optOutEvents(contactId)).toHaveLength(1);
    expect(await getConsentState(testClient, contactId, "sms")).toBe("opted_out");
    expect(await enrollmentStatuses([propertyId])).toEqual([{ property_id: propertyId, status: "opted_out" }]);

    // A second property sharing the contact is blocked by the real guards.
    const contact = await readContact(contactId);
    const consentState = await getConsentState(testClient, contactId, "sms");
    expect(evaluateSuppression({
      outreachDispo: (await readProperty(siblingId)).outreach_dispo,
      consentState,
      doNotContact: contact.do_not_contact,
      smsOptedOut: contact.sms_opted_out,
    }).suppressed).toBe(true);
    const sibling = await enrollLead(testClient, { sequenceId, propertyId: siblingId, enrolledByUserId: actorId });
    expect(sibling.status).not.toBe("enrolled");
  });

  it("opted_out: a failed contact update is retried and ends with sms_opted_out true", async () => {
    const sequenceId = await seedSequence();
    const { propertyId, contactId } = await seedProperty("OptOut");
    const siblingId = await seedSiblingProperty(contactId, "OptOutSibling");
    expect((await enrollLead(testClient, { sequenceId, propertyId, enrolledByUserId: actorId })).status).toBe("enrolled");

    injection = { table: "contacts", op: "update", message: "injected contact update failure" };
    expect(await saveOutreachDispo(propertyId, "opted_out"))
      .toEqual({ ok: false, error: "injected contact update failure", committed: true });
    expect((await readProperty(propertyId)).outreach_dispo).toBe("opted_out");
    expect((await readContact(contactId)).sms_opted_out).toBe(false);
    expect(await optOutEvents(contactId)).toHaveLength(0);

    expect(await saveOutreachDispo(propertyId, "opted_out")).toEqual({ ok: true });

    expect((await readContact(contactId)).sms_opted_out).toBe(true);
    expect(await optOutEvents(contactId)).toHaveLength(1);
    expect(await enrollmentStatuses([propertyId])).toEqual([{ property_id: propertyId, status: "opted_out" }]);

    const contact = await readContact(contactId);
    expect(evaluateSuppression({
      outreachDispo: null,
      consentState: await getConsentState(testClient, contactId, "sms"),
      doNotContact: contact.do_not_contact,
      smsOptedOut: contact.sms_opted_out,
    }).suppressed).toBe(true);
    expect((await enrollLead(testClient, { sequenceId, propertyId: siblingId, enrolledByUserId: actorId })).status).not.toBe("enrolled");
  });

  it("opted_out: a failed enrollment pause is retried and completes", async () => {
    const sequenceId = await seedSequence();
    const { propertyId, contactId } = await seedProperty("Pause");
    expect((await enrollLead(testClient, { sequenceId, propertyId, enrolledByUserId: actorId })).status).toBe("enrolled");

    injection = { table: "sequence_enrollments", op: "update", message: "injected pause failure" };
    expect(await saveOutreachDispo(propertyId, "opted_out"))
      .toEqual({ ok: false, error: "pauseContactEnrollments: injected pause failure", committed: true });
    expect(await optOutEvents(contactId)).toHaveLength(1);
    expect((await enrollmentStatuses([propertyId]))[0]?.status).toBe("active");

    expect(await saveOutreachDispo(propertyId, "opted_out")).toEqual({ ok: true });
    expect(await optOutEvents(contactId)).toHaveLength(1);
    expect((await enrollmentStatuses([propertyId]))[0]?.status).toBe("opted_out");
  });

  it("does not duplicate an opt_out when the contact already opted out (STOP)", async () => {
    const { propertyId, contactId } = await seedProperty("Stop");
    await seedConsent(contactId, "opt_out", "2026-10-01T00:00:00Z");

    expect(await saveOutreachDispo(propertyId, "opted_out")).toEqual({ ok: true });

    expect(await optOutEvents(contactId)).toHaveLength(1);
    expect((await readContact(contactId)).sms_opted_out).toBe(true);
  });

  it("records a new opt_out when the contact opted back in before the manual opt-out", async () => {
    const { propertyId, contactId } = await seedProperty("Reoptin");
    await seedConsent(contactId, "opt_out", "2026-09-01T00:00:00Z");
    await seedConsent(contactId, "opt_in_confirmed", "2026-09-15T00:00:00Z");
    expect(await getConsentState(testClient, contactId, "sms")).toBe("can_send_marketing");

    expect(await saveOutreachDispo(propertyId, "opted_out")).toEqual({ ok: true });

    expect(await optOutEvents(contactId)).toHaveLength(2);
    expect(await getConsentState(testClient, contactId, "sms")).toBe("opted_out");
  });

  it("rejects a training property before any suppression work (same-dispo skip is covered in the unit suite; the DB cannot hold a training row with a dispo)", async () => {
    const { data: contact, error: contactError } = await testClient.from("contacts")
      .insert({ first_name: "Training", last_name: "Test", phone_1: "+18165550123", phone_1_type: "mobile" })
      .select("id").single();
    if (contactError || !contact) throw contactError ?? new Error("contact seed failed");
    const contactId = contact.id;
    // The training marker is immutable and a training row cannot carry a
    // dispo, so seed a plain training property.
    const { data: property, error: propertyError } = await testClient.from("properties")
      .insert({
        address: "1 Training Ln", state: "MO", status: "new_lead",
        homeowner_contact_id: contactId, is_training: true,
      })
      .select("id").single();
    if (propertyError || !property) throw propertyError ?? new Error("property seed failed");
    const propertyId = property.id;

    const result = await saveOutreachDispo(propertyId, "opted_out");

    expect(result.ok).toBe(false);
    expect(await optOutEvents(contactId)).toHaveLength(0);
    expect((await readContact(contactId)).sms_opted_out).toBe(false);
  });

  it.each(["opted_out", "dnc"] as const)("dialer wrap-up retry (%s) after a failed suppression saves exactly one activity and one opt_out", async (disposition) => {
    const { propertyId, contactId } = await seedProperty("Dialer Retry");
    const wrapToken = randomUUID();
    const input = {
      target: {
        propertyId, contactId, phoneE164: "+18165550123", maskedPhone: "(816) 555-0123",
        name: "Dialer Retry", address: "1 Dialer Retry Ln", state: "MO",
        startedAt: "2026-10-03T15:00:00.000Z",
      },
      startedAt: "2026-10-03T15:00:00.000Z",
      endedAt: "2026-10-03T15:01:00.000Z",
      durationSeconds: 60,
      outcome: "connected_human" as const,
      disposition,
      notes: "Asked to stop",
      wrapToken,
    };

    injection = { table: "consent_events", op: "insert", message: "injected consent insert failure" };
    const first = await completeSoftphoneCall(input);
    expect(first.ok).toBe(false);
    const { data: afterFirst } = await testClient.from("call_activities").select("id").eq("wrap_token", wrapToken);
    expect(afterFirst).toEqual([]);

    const second = await completeSoftphoneCall(input);
    expect(second.ok).toBe(true);
    const { data: afterSecond } = await testClient.from("call_activities").select("id").eq("wrap_token", wrapToken);
    expect(afterSecond).toHaveLength(1);
    expect(await optOutEvents(contactId)).toHaveLength(1);
    expect(await getConsentState(testClient, contactId, "sms")).toBe("opted_out");
    expect((await readProperty(propertyId)).outreach_dispo).toBe(disposition);
  });
});
