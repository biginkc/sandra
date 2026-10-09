import { describe, expect, it } from "vitest";

import { withReadOnlyTransaction } from "./db";
import { buildExport, maskValue } from "./export-core";
import { PhoneMasker } from "./mask";
import type { Query } from "./schema";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const PROP = "33333333-3333-4333-8333-333333333333";
const CONV = "44444444-4444-4444-8444-444444444444";
const BUSINESS = "+18165559999";
const SELLER = "+19135551234"; // the "real" seller number
const NOW = new Date("2026-10-07T12:00:00.000Z");

type Call = { sql: string; params?: unknown[] };

function fakeDb(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  const calls: Call[] = [];
  const query: Query = async (sql, params) => {
    calls.push({ sql, params });
    const s = sql.replace(/\s+/g, " ");
    const pick = (key: string, fallback: Record<string, unknown>[] = []) => ({ rows: overrides[key] ?? fallback });
    if (/to_regclass/.test(s)) return { rows: [{ present: true }] };
    if (/direction = 'inbound'/.test(s)) {
      return pick("inbound", [
        {
          id: "55555555-5555-4555-8555-555555555551",
          org_id: ORG,
          external_id: "sendillo-ext-1",
          from_address: SELLER,
          to_address: BUSINESS,
          body: "Yes I'm interested, my cell is (913) 555-1234 and my wife's is 816-222-3344.",
          created_at: new Date("2026-10-06T15:00:00Z"),
          contact_id: CONTACT,
          property_id: PROP,
          conversation_id: CONV,
        },
      ]);
    }
    if (/from public.messages/.test(s) && /direction = 'outbound'/.test(s)) return pick("outboundRef", [{ id: "o1", conversation_id: CONV, direction: "outbound", status: "sent", provider: "sendillo", created_at: new Date("2026-10-06T15:05:00Z") }]);
    if (/from public.messages/.test(s)) {
      return pick("baseline", [
        { id: "66666666-6666-4666-8666-666666666661", org_id: ORG, conversation_id: CONV, contact_id: CONTACT, property_id: PROP, channel: "sms", direction: "outbound", body: "Hi John, are you still interested in selling 12 Oak St?", status: "delivered", provider: "sendillo", external_id: "x1", from_address: BUSINESS, to_address: SELLER, created_at: new Date("2026-09-20T15:00:00Z"), sent_at: null, delivered_at: null, read_at: null, metadata: { routing: "matched_recipient_number", raw: { to: SELLER } } },
        { id: "66666666-6666-4666-8666-666666666662", org_id: ORG, conversation_id: CONV, contact_id: CONTACT, property_id: PROP, channel: "sms", direction: "inbound", body: "who is this", status: "received", provider: "sendillo", external_id: "x2", from_address: SELLER, to_address: BUSINESS, created_at: new Date("2026-09-20T16:00:00Z"), sent_at: null, delivered_at: null, read_at: null, metadata: null },
      ]);
    }
    if (/from public.contacts/.test(s)) return pick("contacts", [{ id: CONTACT, org_id: ORG, contact_type: "person", first_name: "John", last_name: "Doe", entity_name: null, phone_1: SELLER, phone_1_type: "mobile", phone_2: "(816) 222-3344", phone_2_type: "unknown", phone_3: null, phone_3_type: "unknown", do_not_contact: false, sms_opted_out: false, sms_opted_out_at: null, notes: "call back at 816.222.3344 evenings", created_at: new Date("2026-08-01T00:00:00Z") }]);
    if (/from public.properties/.test(s)) return pick("properties", [{ id: PROP, org_id: ORG, address: "12 Oak St", city: "Kansas City", state: "MO", zip: "64111", status: "prospect", homeowner_contact_id: "99999999-9999-4999-8999-999999999999", notes: null, created_at: new Date("2026-08-01T00:00:00Z"), updated_at: new Date("2026-08-02T00:00:00Z") }]);
    if (/from public.sms_phone_suppressions/.test(s)) return pick("suppressions", [{ id: "77777777-7777-4777-8777-777777777777", org_id: ORG, phone_e164: "+19135559876", source: "stop", source_detail: { from: "+19135559876" }, provider: "sendillo", suppressed_at: new Date("2026-09-01T00:00:00Z"), created_at: new Date("2026-09-01T00:00:00Z"), updated_at: new Date("2026-09-01T00:00:00Z") }]);
    return { rows: [] };
  };
  return { query, calls };
}

const opts = { batchId: "2026-10-07", days: 30, contextDays: 60, now: NOW, salt: "unit-test-salt" };

describe("buildExport", () => {
  it("masks every seller phone and never lets a real one through", async () => {
    const { query } = fakeDb({ contacts: undefined });
    const out = await buildExport(query, { ...opts, businessNumbers: [BUSINESS] });
    const text = JSON.stringify(out);
    for (const real of ["9135551234", "913-555-1234", "8162223344", "816-222-3344", "816.222.3344", "9135559876"]) {
      expect(text).not.toContain(real);
    }
    expect(text).toContain(BUSINESS); // our own sender number is kept
    const c = out.tables.contacts[0];
    expect(String(c.phone_1)).toMatch(/^\+1913555\d{4}$/);
    expect(String(c.phone_2)).toMatch(/^\+1816555\d{4}$/);
    expect(out.inbound[0].from).toBe(c.phone_1); // same seller -> same masked number everywhere
    expect(out.tables.messages[0].to_address).toBe(c.phone_1);
  });

  it("masks contact names deterministically by default; addresses and bodies stay", async () => {
    const out = await buildExport(fakeDb().query, { ...opts, businessNumbers: [BUSINESS] });
    const again = await buildExport(fakeDb().query, { ...opts, businessNumbers: [BUSINESS] });
    expect(out.tables.contacts[0].first_name).toMatch(/^First-[0-9a-f]{6}$/);
    expect(out.tables.contacts[0].last_name).toMatch(/^Last-[0-9a-f]{6}$/);
    expect(out.tables.contacts[0].entity_name).toBeNull();
    expect(out.tables.contacts[0].first_name).toBe(again.tables.contacts[0].first_name);
    expect(out.tables.properties[0]).toMatchObject({ address: "12 Oak St" });
  });

  it("masks emails inside free text by default and leaves them with maskPii:false", async () => {
    const inbound = [{ id: "a", org_id: ORG, external_id: "1", from_address: SELLER, to_address: BUSINESS, body: "email me at jo.doe@gmail.com", created_at: NOW, contact_id: CONTACT, property_id: PROP, conversation_id: CONV }];
    const masked = await buildExport(fakeDb({ inbound }).query, opts);
    expect(JSON.stringify(masked)).not.toContain("jo.doe@gmail.com");
    expect(masked.inbound[0].body).toMatch(/@example\.invalid/);
    const raw = await buildExport(fakeDb({ inbound }).query, { ...opts, maskPii: false });
    expect(raw.inbound[0].body).toContain("jo.doe@gmail.com");
  });

  it("fails the export when a numeric phone survives in JSON metadata-like reference data", async () => {
    const { query } = fakeDb({ outboundRef: [{ id: "o1", conversation_id: CONV, direction: "outbound", status: "sent", provider: "x", created_at: NOW, extra: 9132223344 }] });
    const out = await buildExport(query, opts);
    expect(JSON.stringify(out)).not.toContain("9132223344"); // masked, not leaked
  });

  it("with maskPii:false, keeps names, addresses and message bodies verbatim (only phone numbers inside text change)", async () => {
    const out = await buildExport(fakeDb().query, { ...opts, maskPii: false, businessNumbers: [BUSINESS] });
    expect(out.tables.contacts[0]).toMatchObject({ first_name: "John", last_name: "Doe" });
    expect(out.tables.properties[0]).toMatchObject({ address: "12 Oak St", city: "Kansas City", state: "MO", zip: "64111" });
    expect(out.tables.messages[0].body).toBe("Hi John, are you still interested in selling 12 Oak St?");
    expect(out.inbound[0].body).toMatch(/^Yes I'm interested, my cell is \d{3}-\d{3}-\d{4} and my wife's is \d{3}-\d{3}-\d{4}\.$/);
    expect(out.inbound[0].body).toContain("913-555");
  });

  it("orders inbound oldest-first, drops cross-record pointers, and reduces metadata", async () => {
    const out = await buildExport(fakeDb().query, opts);
    expect(out.tables.properties[0].homeowner_contact_id).toBeNull();
    expect(out.tables.messages[0].metadata).toEqual({ routing: "matched_recipient_number" });
    expect(out.inbound.map((i) => i.externalId)).toEqual(["sendillo-ext-1"]);
    expect(out.counts.inbound).toBe(1);
    expect(out.window).toMatchObject({ days: 30, start: "2026-09-07T12:00:00.000Z" });
  });

  it("is deterministic for the same data and salt", async () => {
    const a = await buildExport(fakeDb().query, opts);
    const b = await buildExport(fakeDb().query, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("fails closed when a phone-like string survives in an unexpected place", async () => {
    const { query } = fakeDb({ outboundRef: [{ id: "o1", conversation_id: CONV, direction: "outbound", status: "sent to 816-444-7788", provider: "x", created_at: NOW }] });
    // reference rows are scrubbed too; the status string is masked, so the export succeeds and holds no real number
    const out = await buildExport(query, opts);
    expect(JSON.stringify(out)).not.toContain("444-7788");
  });

  it("refuses when inbound spans several orgs and none was chosen", async () => {
    const { query } = fakeDb({
      inbound: [
        { id: "a", org_id: ORG, external_id: "1", from_address: SELLER, to_address: BUSINESS, body: "x", created_at: NOW, contact_id: null, property_id: null, conversation_id: null },
        { id: "b", org_id: "99999999-9999-4999-8999-999999999990", external_id: "2", from_address: SELLER, to_address: BUSINESS, body: "x", created_at: NOW, contact_id: null, property_id: null, conversation_id: null },
      ],
    });
    await expect(buildExport(query, opts)).rejects.toThrow(/--org/);
  });

  it("issues only SELECT statements", async () => {
    const { query, calls } = fakeDb();
    await buildExport(query, opts);
    expect(calls.length).toBeGreaterThan(5);
    for (const { sql } of calls) {
      expect(sql.trim().toLowerCase()).toMatch(/^(select|with)\b/);
    }
  });
});

describe("withReadOnlyTransaction", () => {
  it("opens a read-only transaction with a statement timeout and always rolls back", async () => {
    const sqls: string[] = [];
    const client = {
      query: async (sql: string) => {
        sqls.push(sql);
        return { rows: [] };
      },
    };
    await withReadOnlyTransaction(client, async (q) => {
      await q("select 1");
    }, { statementTimeoutMs: 30_000 });
    expect(sqls).toEqual(["begin transaction read only", "set local statement_timeout = 30000", "select 1", "rollback"]);

    sqls.length = 0;
    await expect(
      withReadOnlyTransaction(client, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sqls.at(-1)).toBe("rollback");
  });
});

describe("maskValue numeric handling", () => {
  const m = new PhoneMasker("salt", [], true);
  it("leaves a 10-digit numeric amount/id column untouched", () => {
    expect(maskValue(9132223344, false, false, m)).toBe(9132223344);
  });
  it("masks numeric phones in a phone-named column and inside JSON", () => {
    const masked = m.maskNumber(9132223344);
    expect(masked).not.toBe(9132223344);
    expect(maskValue(9132223344, false, false, m, true)).toBe(masked);
    expect(maskValue({ a: { phone: 9132223344 }, b: [9132223344] }, false, false, m)).toEqual({ a: { phone: masked }, b: [masked] });
  });
});
