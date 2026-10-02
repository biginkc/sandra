import { describe, expect, it } from "vitest";
import { referenceMatch, prefixQueryTokens, normalizeQuery } from "./reference-matcher";
import type { OracleFixture, OracleProperty, OracleContact, OracleMessage } from "./types";

const prop = (o: Partial<OracleProperty> & { id: string }): OracleProperty => ({
  org_id: "A", address: null, city: null, state: null, zip: null, market: null, apn: null, mls_number: null,
  homeowner_contact_id: null, agent_contact_id: null, deleted_at: null, is_training: false, status: "prospect", ...o,
});
const contact = (o: Partial<OracleContact> & { id: string }): OracleContact => ({
  org_id: "A", first_name: null, last_name: null, entity_name: null, email: null, phone_1: null, phone_2: null, phone_3: null, ...o,
});
const msg = (o: Partial<OracleMessage> & { id: string }): OracleMessage => ({
  org_id: "A", property_id: null, contact_id: null, conversation_id: "c1", channel: "sms", direction: "inbound", body: null, ...o,
});
const NOW = new Date("2026-10-02T00:00:00Z");
const mem = (o = {}) => ({ user_id: "u", org_id: "A", access_status: "active", access_expires_at: null, deletion_prepared_at: null, ...o });
const fx = (p: Partial<OracleFixture>): OracleFixture => ({
  properties: [], contacts: [], messages: [], memberships: [mem()], users: [{ id: "u", orgIds: ["A"] }], ...p,
});
const run = (f: OracleFixture, q: string, includeMessages = true, user: string | null = "u") =>
  [...referenceMatch(f, { q, includeMessages }, user, { now: NOW })].sort();

describe("reference matcher", () => {
  it("property fields, case-insensitive substring", () => {
    const f = fx({ properties: [prop({ id: "p1", address: "123 Main St", city: "Kansas City", apn: "AB-12" }), prop({ id: "p2", address: "9 Oak" })] });
    expect(run(f, "MAIN")).toEqual(["p1"]);
    expect(run(f, "ab-12")).toEqual(["p1"]);
    expect(run(f, "ma")).toEqual([]); // <3 chars
    expect(run(f, "  ma  ")).toEqual([]); // trimmed first
  });
  it("collapses internal whitespace runs", () => {
    const f = fx({ contacts: [contact({ id: "c1", entity_name: "Doe Family Trust" })], properties: [prop({ id: "p1", homeowner_contact_id: "c1" })] });
    expect(run(f, "doe   family")).toEqual(["p1"]);
    expect(run(f, "doe\t \nfamily")).toEqual(["p1"]);
  });
  it("whitespace: tabs/newlines collapse, trim, cut, trim", () => {
    expect(normalizeQuery("\tab")).toBe("ab");
    expect(normalizeQuery("a\n\n b")).toBe("a b");
    expect(normalizeQuery("x".repeat(99) + "  y")).toBe("x".repeat(99));
    expect(run(fx({ properties: [prop({ id: "p1", address: "ab" })] }), "\tab")).toEqual([]);
  });
  it("phone matching needs a structured query", () => {
    const f = fx({ contacts: [contact({ id: "c1", phone_1: "816-555-0101" })], properties: [prop({ id: "p1", homeowner_contact_id: "c1" })] });
    expect(run(f, "101 Zephyr")).toEqual([]);
    expect(run(f, "555-0101")).toEqual(["p1"]);
    expect(run(f, "xxxxxx 555 0101")).toEqual([]);
  });
  it("hostile chars are literal", () => {
    const f = fx({ properties: [prop({ id: "p1", address: "50% off_x" }), prop({ id: "p2", address: "abcdef" })] });
    expect(run(f, "%")).toEqual([]);
    expect(run(f, "0% o")).toEqual(["p1"]);
    expect(run(f, "___")).toEqual([]);
  });
  it("homeowner and agent contacts, every property, not just newest", () => {
    const f = fx({
      contacts: [contact({ id: "c1", first_name: "Jane", last_name: "Doe" }), contact({ id: "c2", last_name: "Agentson" })],
      properties: [prop({ id: "p1", homeowner_contact_id: "c1" }), prop({ id: "p2", homeowner_contact_id: "c1" }), prop({ id: "p3", agent_contact_id: "c2" })],
    });
    expect(run(f, "jane doe")).toEqual(["p1", "p2"]);
    expect(run(f, "agentson")).toEqual(["p3"]);
  });
  it("contact in another org does not link to property", () => {
    const f = fx({ memberships: [mem(), mem({ org_id: "B" })], contacts: [contact({ id: "c1", org_id: "B", last_name: "Crossorg" })], properties: [prop({ id: "p1", homeowner_contact_id: "c1" })] });
    expect(run(f, "crossorg")).toEqual([]);
  });
  it("phones by digits", () => {
    const f = fx({
      contacts: [contact({ id: "c1", phone_2: "(555) 123-4567" })],
      properties: [prop({ id: "p1", homeowner_contact_id: "c1" })],
    });
    for (const q of ["555.123.4567", "4567", "123-45"]) expect(run(f, q), q).toEqual(["p1"]);
    expect(run(f, "+15551234567")).toEqual(["p1"]); // leading 1 dropped from 11-digit query
    expect(run(f, "+1 555 123 4567")).toEqual([]); // literal ruling: 10 digits vs 15-char query is under 70%
    expect(run(f, "1 555 123 4568")).toEqual([]);
    expect(run(f, "45")).toEqual([]);
    expect(run(f, "5551234568")).toEqual([]);
  });
  it("messages: sms only, prefix AND, includeMessages gate", () => {
    const f = fx({
      properties: [prop({ id: "p1" }), prop({ id: "p2" }), prop({ id: "p3" })],
      messages: [
        msg({ id: "m1", property_id: "p1", body: "Can you do $250,000 cash?" }),
        msg({ id: "m2", property_id: "p2", channel: "email", body: "cash offer" }),
        msg({ id: "m3", property_id: "p3", conversation_id: null, body: "cash offer" }),
      ],
    });
    expect(run(f, "cash")).toEqual(["p1"]);
    expect(run(f, "cas 250")).toEqual(["p1"]);
    expect(run(f, "cash zzz")).toEqual([]);
    expect(run(f, "cash", false)).toEqual([]);
    expect(prefixQueryTokens("ab cd")).toBeNull();
    expect(prefixQueryTokens("ab cde")).toEqual(["ab", "cde"]);
  });
  it("deleted properties and foreign orgs never match", () => {
    const f = fx({
      properties: [prop({ id: "p1", address: "zebra", deleted_at: "2026-01-01" }), prop({ id: "p2", org_id: "B", address: "zebra" })],
    });
    expect(run(f, "zebra")).toEqual([]);
  });
  it("membership gates", () => {
    const p = [prop({ id: "p1", address: "zebra" })];
    expect(run(fx({ properties: p, memberships: [mem({ access_status: "suspended" })] }), "zebra")).toEqual([]);
    expect(run(fx({ properties: p, memberships: [mem({ access_expires_at: "2026-10-01T00:00:00Z" })] }), "zebra")).toEqual([]);
    expect(run(fx({ properties: p, memberships: [mem({ access_expires_at: "2026-10-03T00:00:00Z" })] }), "zebra")).toEqual(["p1"]);
    expect(run(fx({ properties: p, memberships: [mem({ deletion_prepared_at: "2026-09-01" })] }), "zebra")).toEqual([]);
    expect(run(fx({ properties: p }), "zebra", true, null)).toEqual([]);
  });
  it("normalizeQuery truncates to 100 codepoints", () => {
    expect(Array.from(normalizeQuery("x".repeat(500))).length).toBe(100);
  });
});

import { generateFixture, USERS } from "./fixture-generator";
import { CI_QUERIES, localQueries } from "./queries";

describe("generator + queries", () => {
  it("is deterministic and sized", () => {
    const a = generateFixture(), b = generateFixture();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.properties.length).toBe(300);
    expect(CI_QUERIES.length).toBe(30);
    expect(localQueries(a).length).toBe(200);
  });
  it("planted targets behave as designed", () => {
    const f = generateFixture();
    const m = (q: string, user: string, inc = true) => referenceMatch(f, { q, includeMessages: inc }, user, { now: new Date("2026-10-02T00:00:00Z") });
    expect(m("xylophone", USERS.a).size).toBe(2); // sms in A with conversation; not email, org B, orphan, unlinked
    expect(m("xylophone", USERS.a, false).size).toBe(0);
    expect(m("xylophone", USERS.nobody).size).toBe(0);
    expect(m("xylophone", USERS.expired).size).toBe(0);
    expect(m("zeppelin", USERS.a).size).toBe(1); // deleted out; training row IN under plan section 1 literal (see excludeTraining)
    expect(m("jane doe", USERS.both).size).toBeGreaterThan(m("jane doe", USERS.a).size);
  });
});
