import { describe, expect, it } from "vitest";
import { compareInboxActionIdentity, InvalidInboxActionError, parseInboxActionDefinition, parseInboxActionIntent, parseReviewedInboxReply } from "./action-definition";
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { organizationId: id(1), requesterId: id(2) };
const target = (n: number) => ({ kind: "conversation", id: id(n) });
const definition = { version: 1, steps: [{ type: "outcome", value: "not_interested" }, { type: "assign", userId: id(3) }] };
const request = () => ({ idempotencyKey: id(4), targets: [target(5), target(6)], definition });
const parse = (value: unknown, scope = context) => parseInboxActionIntent(JSON.stringify(value), scope);
const reply = (n = 2) => ({ idempotencyKey: id(4), previewId: id(8), previewVersion: 1, itemIds: Array.from({ length: n }, (_, i) => id(i + 20)) });

describe("Inbox action input boundaries", () => {
  it("canonicalizes target/key/UUID order but preserves ordered steps and content", () => {
    const first = parse(request());
    const second = parse({ definition: { steps: definition.steps, version: 1 }, targets: [target(6), { kind: "conversation", id: id(5).toUpperCase() }], idempotencyKey: id(99) });
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    const steps = [{ type: "promote" }, { type: "assign", userId: null }];
    expect(parse({ ...request(), definition: { version: 1, steps } }).inputHash).not.toBe(parse({ ...request(), definition: { version: 1, steps: [...steps].reverse() } }).inputHash);
    const textHash = (text: string) => parse({ ...request(), definition: { version: 1, steps: [{ type: "review_reply", text }] } }).inputHash;
    expect(textHash("hello")).toBe(textHash(" hello "));
    expect(textHash("hello world")).not.toBe(textHash("hello  world"));
  });
  it("binds both organization and requester, with no client scope override", () => {
    const original = parse(request()).inputHash;
    expect(parse(request(), { ...context, organizationId: id(9) }).inputHash).not.toBe(original);
    expect(parse(request(), { ...context, requesterId: id(9) }).inputHash).not.toBe(original);
    expect(() => parse({ ...request(), organizationId: id(9) })).toThrow(InvalidInboxActionError);
    expect(() => parse(request(), { ...context, requesterId: "anonymous" })).toThrow(InvalidInboxActionError);
  });
  it.each(["enroll_sequence", "manage_sequence", "ai", "apology_dnc", "book_appointment", "merge_contact", "new_message", "send_reply"])("rejects unsupported step %s", (type) => {
    expect(() => parse({ ...request(), definition: { version: 1, steps: [{ type }] } })).toThrow(InvalidInboxActionError);
  });
  it.each(["callback_requested", "booked_appointment", "No outcome", "interested"])("rejects non-settable outcome %s", (value) => {
    expect(() => parse({ ...request(), definition: { version: 1, steps: [{ type: "outcome", value }] } })).toThrow(InvalidInboxActionError);
  });
  it.each(["wrong_number", "bad_number", "not_interested", "needs_sequence", "nurture", "opted_out", "dnc"])("preserves existing outcome code %s without asserting eligibility", (value) => {
    expect(parse({ ...request(), definition: { version: 1, steps: [{ type: "outcome", value }] } }).requiresAuthoritativePreparation).toBe(true);
  });
  it("retains mixed typed targets and disallows client-resolved property/unknown IDs", () => {
    const mixed = [target(5), { kind: "unknown_sender_group", id: id(5) }];
    expect(parse({ ...request(), targets: mixed }).input.targets).toHaveLength(2);
    for (const extra of [{ propertyId: id(7) }, { eligible: true }, { messageIds: [id(7)] }, { policyVersion: 1 }]) {
      expect(() => parse({ ...request(), targets: [{ ...target(5), ...extra }] })).toThrow(InvalidInboxActionError);
    }
    for (const type of ["dismiss_unknown", "restore_unknown"]) {
      expect(parse({ ...request(), targets: mixed, definition: { version: 1, steps: [{ type }] } }).input.targets).toHaveLength(2);
    }
  });
  it("rejects duplicate/conflicting steps, backwards dependency, or a reply before metadata", () => {
    for (const steps of [[...definition.steps].reverse(), [definition.steps[0], definition.steps[0]], [{ type: "dismiss_unknown" }, { type: "restore_unknown" }], [{ type: "assign", userId: null }, { type: "assign", userId: id(3) }], [{ type: "review_reply", text: "hello" }, { type: "promote" }]]) {
      expect(() => parse({ ...request(), definition: { version: 1, steps } })).toThrow(InvalidInboxActionError);
    }
  });
  it("bounds raw bytes, target count, empty input, IDs and text", () => {
    expect(() => parseInboxActionIntent(" ".repeat(131073), context)).toThrow(InvalidInboxActionError);
    expect(() => parseInboxActionIntent("{", context)).toThrow(InvalidInboxActionError);
    for (const targets of [[], [target(5), target(5)], [{ kind: "conversation", id: "x" }], Array.from({ length: 501 }, (_, i) => target(i))]) expect(() => parse({ ...request(), targets })).toThrow(InvalidInboxActionError);
    for (const text of [" ", "x".repeat(1601)]) expect(() => parse({ ...request(), definition: { version: 1, steps: [{ type: "review_reply", text }] } })).toThrow(InvalidInboxActionError);
    expect(parse({ ...request(), definition: { version: 1, steps: [{ type: "review_reply", text: "x".repeat(1600) }] } }).input.definition.steps).toHaveLength(1);
    expect(() => parseInboxActionDefinition(JSON.stringify({ version: 1, steps: [] }))).toThrow(InvalidInboxActionError);
  });
  it("copies an immutable personally-owned saved version and rejects version/owner mismatch", () => {
    const saved = { ...context, id: id(10), version: 2, definition: { version: 1 as const, steps: [{ type: "promote" as const }] } };
    const body = JSON.stringify({ idempotencyKey: id(4), targets: [target(5)], savedAction: { id: saved.id, version: 2 } });
    const result = parseInboxActionIntent(body, context, saved);
    saved.definition.steps.push({ type: "promote" });
    expect(result.input.definition.steps).toHaveLength(1);
    expect(Object.isFrozen(result.input.definition.steps[0])).toBe(true);
    for (const override of [{ requesterId: id(99) }, { organizationId: id(99) }, { version: 3 }]) expect(() => parseInboxActionIntent(body, context, { ...saved, ...override })).toThrow(InvalidInboxActionError);
  });
  it("accepts at most 50 reviewed item references and never client content or route", () => {
    expect(parseReviewedInboxReply(JSON.stringify(reply(50)), context).input.itemIds).toHaveLength(50);
    for (const body of [reply(51), reply(0), { ...reply(), itemIds: [id(20), id(20)] }, { ...reply(), text: "send this" }, { ...reply(), to: "+15555550100" }, { ...reply(), previewVersion: 1.5 }]) expect(() => parseReviewedInboxReply(JSON.stringify(body), context)).toThrow(InvalidInboxActionError);
    const first = parseReviewedInboxReply(JSON.stringify(reply()), context);
    expect(parseReviewedInboxReply(JSON.stringify({ ...reply(), itemIds: reply().itemIds.reverse() }), context).inputHash).toBe(first.inputHash);
    expect(parseReviewedInboxReply(JSON.stringify({ ...reply(), previewVersion: 2 }), context).inputHash).not.toBe(first.inputHash);
    expect(compareInboxActionIdentity(first.inputHash, first.inputHash)).toBe("reuse_existing");
    expect(compareInboxActionIdentity(first.inputHash, parse(request()).inputHash)).toBe("conflict");
  });
});


describe("unambiguous persistable JSON", () => {
  it.each([
    '{"version":1,"version":1,"steps":[{"type":"promote"}]}',
    '{"version":1,"steps":[{"type":"outcome","value":"not_interested","value":"dnc"}]}',
    '{"version":1,"steps":[{"type":"outcome","value":"not_interested","val\\u0075e":"dnc"}]}',
  ])("rejects duplicate decoded keys: %s", (raw) => {
    expect(() => parseInboxActionDefinition(raw)).toThrow(InvalidInboxActionError);
  });
  it("scans quoted delimiters and repeated keys in separate objects correctly", () => {
    const text = 'hello "value":"x", { [ \\ world';
    const result = parseInboxActionDefinition(JSON.stringify({ version: 1, steps: [{ type: "promote" }, { type: "review_reply", text }] }));
    expect(result.steps[1]).toEqual({ type: "review_reply", text });
  });
  it.each(["hello\u0000", "hello\ud800", "hello\udc00", "hello\ud800x"])("rejects non-persistable Unicode %j", (text) => {
    expect(() => parseInboxActionDefinition(JSON.stringify({ version: 1, steps: [{ type: "review_reply", text }] }))).toThrow(InvalidInboxActionError);
  });
  it("preserves valid Unicode and internal whitespace, trimming before the Inbox cap", () => {
    const text = " \n" + "😀".repeat(800) + " ";
    expect(parseInboxActionDefinition(JSON.stringify({ version: 1, steps: [{ type: "review_reply", text }] })).steps[0]).toEqual({ type: "review_reply", text: "😀".repeat(800) });
  });
});
