import { afterEach, describe, expect, it, vi } from "vitest";
import { createInboxReplyRepository, type InboxReplyClient } from "./reply-api";

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const template = "Hi {{first_name}}, I'm {{my_first_name}}.";
const target = (n: number) => ({ kind: "conversation" as const, id: id(n) });
const request = () => ({ idempotencyKey: id(4), targets: [target(5)], template });
const baseVars = { first_name: "Ada", last_name: "Lovelace", property_address: "12 Main", city: "KC", state: "MO", property_zip: "64101", market: "KC Metro", company_name: "BMH" };
const captureItem = (n: number, overrides: Record<string, unknown> = {}) => ({
  conversation_id: id(n), exclusion: null, property_id: id(100 + n), contact_id: id(200 + n),
  from: "+18165550001", to: "+18165550002", state: "MO", inbound_id: id(300 + n),
  inbound_created_at: "2026-09-01T00:00:00Z", valid_until: "2099-01-01T00:00:00Z",
  variables: baseVars, dependencies: { head: "1" }, duplicate_destination: false,
  quiet_hours: { ok: true }, ...overrides,
});
const freezeItemFor = (n: number, renderedBody: string) => ({
  id: id(900 + n), target: target(n), exclusion: null,
  recipient: { contactName: "Ada Lovelace", propertyAddress: "12 Main", propertyId: id(100 + n), contactId: id(200 + n), from: "+18165550001", to: "+18165550002", renderedBody },
  duplicateDestination: false,
});
const excludedFreezeItem = (n: number, exclusion: string, kind: "conversation" | "unknown_sender_group" = "conversation") => ({
  id: id(900 + n), target: { kind, id: id(n) }, exclusion, recipient: null, duplicateDestination: false,
});
const freezeResult = (items: unknown[], overrides: Record<string, unknown> = {}) => ({
  preparationId: id(999), idempotencyKey: id(4), inputHash: "a".repeat(64), expiresAt: "2026-09-14T00:05:00Z",
  items, recipientCount: items.filter((i) => (i as { exclusion: unknown }).exclusion === null).length, blockers: [],
  replayed: false, ...overrides,
});
const ok = (data: unknown) => ({ data, error: null });
function client(results: unknown[]) {
  const seenSignals: AbortSignal[] = [];
  const rpc = vi.fn((_name: string, _args?: Record<string, unknown>) => ({
    abortSignal: vi.fn((s: AbortSignal) => {
      seenSignals.push(s);
      const r = results.shift();
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r);
    }),
  }));
  return { rpc, seenSignals, repository: createInboxReplyRepository({ rpc } as unknown as InboxReplyClient) };
}
afterEach(() => vi.unstubAllEnvs());

describe("malformed prepare intent is rejected before any RPC (obligation 3)", () => {
  const cases: [string, string][] = [
    ["duplicate top-level member", `{"idempotencyKey":"${id(4)}","idempotencyKey":"${id(4)}","targets":[{"kind":"conversation","id":"${id(5)}"}],"template":"hi"}`],
    ["over-limit targets (501)", JSON.stringify({ idempotencyKey: id(4), targets: Array.from({ length: 501 }, (_, i) => target(1000 + i)), template: "hi" })],
    ["duplicate target", JSON.stringify({ idempotencyKey: id(4), targets: [target(5), target(5)], template: "hi" })],
    ["missing template key", JSON.stringify({ idempotencyKey: id(4), targets: [target(5)] })],
  ];
  it.each(cases)("%s -> 400, no RPC", async (_label, raw) => {
    const c = client([]);
    await expect(c.repository.prepare(raw, signal())).rejects.toMatchObject({ status: 400 });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  // MUTATION: bypassing wire()'s duplicate-member scan (e.g. parsing with a
  // plain JSON.parse that silently last-value-wins) makes the first case pass
  // through to a 200/RPC call instead of 400.
});

describe("template-wide probe render rejects before capture RPC (obligation 4, C3)", () => {
  it.each(["Hi {{unknown_var}}", "Hi {{first_name", "{{#if x}}bad", ""])("rejects %s as invalid_template with no capture RPC", async (badTemplate) => {
    const c = client([]);
    const raw = JSON.stringify({ ...request(), template: badTemplate || "  " });
    await expect(c.repository.prepare(raw, signal())).rejects.toMatchObject({ status: 400, code: "invalid_template" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  // MUTATION: removing the probe-render try/catch (calling renderReviewedReply
  // without the full-placeholder PROBE_VARS map, or not calling it at all)
  // makes an unknown-variable template reach the capture RPC instead of 400.
});

describe("freeze DTO validation is fail-closed (obligation 5, C8)", () => {
  it("rejects an altered renderedBody that doesn't equal what the coordinator sent", async () => {
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([freezeItemFor(5, "ALTERED TEXT THE SERVER NEVER SENT")]);
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  // MUTATION: dropping the `expected === renderedBody` equality check lets a
  // tampered/mismatched server body pass straight through as a 200.
  it("rejects an extra item beyond target count", async () => {
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([freezeItemFor(5, "Hi Ada, I'm Mel."), excludedFreezeItem(6, "conversation_unavailable")]);
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  it("rejects a missing item (fewer items than targets)", async () => {
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([]);
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  it("rejects a non-null recipient on an excluded item", async () => {
    const capture = { items: [captureItem(5, { exclusion: "property_unavailable" })] };
    const bogus = { ...excludedFreezeItem(5, "property_unavailable"), recipient: { contactName: "x", propertyAddress: "x", propertyId: id(1), contactId: id(2), from: "+18165550001", to: "+18165550002", renderedBody: "x" } };
    // blockers:["empty"] matches this fixture's recipientCount (0) correctly,
    // so the 503 here can ONLY come from need(row.recipient === null) — not
    // from the (also-failing, but unrelated) empty-blocker equivalence check.
    // Without this override the default blockers:[] mismatches recipientCount
    // 0 too, and the test would still 503 even if the strict-null guard were
    // deleted — masking the very check it claims to cover.
    const freeze = freezeResult([bogus], { blockers: ["empty"] });
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  // MUTATION: relaxing `need(row.recipient === null)` to accept any
  // non-undefined value (or dropping it) makes this test — isolated from the
  // empty-blocker check by the override above — incorrectly resolve instead
  // of rejecting.
  it("rejects a recipientCount:0 response whose blockers omit 'empty' (empty-blocker equivalence)", async () => {
    const capture = { items: [captureItem(5, { exclusion: "property_unavailable" })] };
    const freeze = freezeResult([excludedFreezeItem(5, "property_unavailable")], { blockers: [] });
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  // MUTATION: dropping `need(blockers.includes("empty") === (recipientCount
  // === 0))` (or weakening it to a one-directional check) makes this
  // well-formed-otherwise excluded-only response — recipientCount 0 but no
  // 'empty' blocker — incorrectly resolve instead of rejecting.
  it("rejects an exclusion string outside INBOX_REPLY_EXCLUSIONS", async () => {
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([excludedFreezeItem(5, "not_a_real_exclusion_code")]);
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  it("rejects a mismatched idempotencyKey echoed back by freeze", async () => {
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([freezeItemFor(5, "Hi Ada, I'm Mel.")], { idempotencyKey: id(7) });
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  // B1-1 total fail-closed validation: an eligible item (exclusion === null)
  // can only ever be a "conversation" target — freeze() marks every other
  // target kind unsupported_target (setup.sql:95), so an eligible
  // unknown_sender_group item can only be forged/broken. This is the case a
  // partial (kind-guarded) body-equality check let through: a forged item
  // whose target.kind !== "conversation" carrying a recipient never has its
  // body checked against anything, and previously wasn't rejected for its
  // kind either.
  it("rejects an eligible (non-excluded) item whose target is not a conversation", async () => {
    const capture = { items: [] };
    const forged = {
      id: id(900), target: { kind: "unknown_sender_group", id: id(50) }, exclusion: null,
      recipient: { contactName: "Ada", propertyAddress: "12 Main", propertyId: id(101), contactId: id(201), from: "+18165550001", to: "+18165550002", renderedBody: "Forged body" },
      duplicateDestination: false,
    };
    const freeze = freezeResult([forged], { recipientCount: 1 });
    const c = client([ok(freeze)]);
    const req = JSON.stringify({ idempotencyKey: id(4), targets: [{ kind: "unknown_sender_group", id: id(50) }], template });
    await expect(c.repository.prepare(req, signal())).rejects.toMatchObject({ status: 503 });
  });
  // MUTATION: reverting the kind-guard deletion (i.e. re-adding `if
  // (target.kind === "conversation")` around the eligible-item checks/body
  // equality, or dropping the `need(target.kind === "conversation")` guard
  // entirely) lets this forged unknown_sender_group item pass straight
  // through as an eligible recipient instead of a 503.
  it("rejects mismatched blockers, recipientCount, or duplicateDestination cross-item invariants", async () => {
    const capture = { items: [captureItem(5), captureItem(6, { conversation_id: id(6) })] };
    const dupItem = (n: number) => ({ ...freezeItemFor(n, "Hi Ada, I'm Mel."), duplicateDestination: true });
    // two eligible items share `to`, but the server lies and reports no
    // duplicate_destination blocker (and an under-counted recipientCount).
    const freeze = freezeResult([dupItem(5), dupItem(6)], { blockers: [], recipientCount: 1 });
    const c = client([ok(capture), ok(freeze)]);
    const req = JSON.stringify({ idempotencyKey: id(4), targets: [target(5), target(6)], template });
    await expect(c.repository.prepare(req, signal())).rejects.toMatchObject({ status: 503 });
  });
});

describe("freeze replayed flag controls body equality (B2, obligation 5)", () => {
  it("trusts an immutable replayed row structurally and never re-compares it against a fresh render", async () => {
    // Dependency drift between the fresh capture (used to build this
    // request's own draft) and what the SERVER's immutable replayed row
    // actually contains is exactly the scenario a legitimate idempotent
    // replay after drift produces. The fresh render below ("Hi Ada, I'm
    // Mel.") intentionally does NOT match the replayed row's body — proving
    // the coordinator never runs the fresh-body-equality check on replay.
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([freezeItemFor(5, "Hi Ada, drifted body from the ORIGINAL frozen row.")], { replayed: true });
    const c = client([ok(capture), ok(freeze)]);
    const result = await c.repository.prepare(JSON.stringify(request()), signal());
    expect(result.items[0].recipient?.renderedBody).toBe("Hi Ada, drifted body from the ORIGINAL frozen row.");
  });
  // MUTATION: dropping the `replayed` append in setup.sql's freeze() existing-row
  // branch (so the RPC response has no `replayed` field, or always reports
  // `false`) makes `bool(row.replayed)` throw or makes this legitimate replay
  // wrongly run fresh-body-equality against the drifted immutable row —
  // either way this test fails.
  it("applies fresh-render body equality when replayed is false, rejecting a mismatch", async () => {
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([freezeItemFor(5, "ALTERED TEXT THE SERVER NEVER SENT")], { replayed: false });
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  // MUTATION: applying fresh-render body equality unconditionally on
  // replayed:true (i.e. never branching on the flag) makes the legitimate
  // replay-after-drift test above fail — it would incorrectly 503 instead of
  // returning 200 with the original frozen body.

  // Both gates confirmed the replayed:true path enforces every structural
  // invariant except fresh body-equality (skipped by design — `replayed`
  // comes only from the trusted SQL fn, never client-settable). Previously
  // that was proven only by ad-hoc probes; these pin it as committed tests.
  it("rejects a blank renderedBody even when replayed is true", async () => {
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([freezeItemFor(5, "   ")], { replayed: true });
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  // MUTATION: relaxing the renderedBody check from `typeof renderedBody ===
  // "string" && renderedBody.trim().length > 0 && renderedBody.length <=
  // 1600` down to just `typeof renderedBody === "string"` makes this
  // blank-body replayed row incorrectly resolve instead of rejecting.
  it("rejects a renderedBody over 1600 UTF-16 units even when replayed is true", async () => {
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([freezeItemFor(5, "x".repeat(1601))], { replayed: true });
    const c = client([ok(capture), ok(freeze)]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  // MUTATION: the same renderedBody relaxation above (dropping the `<=
  // 1600` clause) makes this over-length replayed body incorrectly resolve.
  it("rejects a missing or non-boolean replayed field instead of silently taking the trust path", async () => {
    // Deliberately uses a body that WOULD legitimately match the fresh
    // render ("Hi Ada, I'm Mel." for id(5)) — so ANY silent coercion of a
    // malformed `replayed` value, in EITHER direction (defaulting to false
    // and running equality against a body that happens to match, or
    // defaulting to true and skipping equality altogether), would let this
    // resolve as 200. Only a strict typeof-boolean check 503s regardless of
    // which way a buggy coercion leans.
    const capture = { items: [captureItem(5)] };
    for (const overrides of [{ replayed: undefined }, { replayed: "true" }, { replayed: 1 }]) {
      // freezeResult()'s spread would keep the key at `undefined` for the
      // first case, which JSON.stringify would drop — but here the mock
      // response is the object itself (never serialized), so `row.replayed`
      // really is `undefined` on the object bool() receives, matching the
      // "field omitted by the RPC" case exactly.
      const freeze = freezeResult([freezeItemFor(5, "Hi Ada, I'm Mel.")], overrides);
      const c = client([ok(capture), ok(freeze)]);
      await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
    }
  });
  // MUTATION: changing `const replayed = bool(row.replayed);` to something
  // like `row.replayed === true` (silently defaulting non-boolean/missing
  // values to `false`, then running fresh-body-equality — which this
  // fixture's body happens to satisfy) would make this test fail to reject
  // the non-boolean cases and incorrectly resolve as 200 instead of 503.
  it("still enforces structural invariants on a replay: missing recipient field, wrong idempotencyKey, and item/target count mismatch each 503", async () => {
    const capture = { items: [captureItem(5)] };
    // missing recipient field (contactId absent) on an otherwise-eligible
    // replayed item.
    const missingField = { ...freezeItemFor(5, "Hi Ada, I'm Mel."), recipient: { ...freezeItemFor(5, "Hi Ada, I'm Mel.").recipient, contactId: undefined } };
    await expect(client([ok(capture), ok(freezeResult([missingField], { replayed: true }))]).repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
    // wrong idempotencyKey echoed back on a replayed response.
    await expect(client([ok(capture), ok(freezeResult([freezeItemFor(5, "Hi Ada, I'm Mel.")], { replayed: true, idempotencyKey: id(7) }))]).repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
    // item count doesn't match target count on a replayed response.
    await expect(client([ok(capture), ok(freezeResult([freezeItemFor(5, "Hi Ada, I'm Mel."), excludedFreezeItem(6, "conversation_unavailable")], { replayed: true }))]).repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status: 503 });
  });
  // MUTATION: short-circuiting any of the envelope/per-item structural
  // checks (id() UUID validation on recipient fields, the idempotencyKey
  // echo check, or the `row.items.length === parsed.targets.length` check)
  // specifically when `replayed` is true would make each respective case
  // above incorrectly resolve instead of rejecting — proving those guards
  // are NOT gated on `!replayed` the way fresh-body-equality alone is.
});

describe("canonical envelope drafts (obligation 7, C5)", () => {
  it("includes a draft only for eligible conversation capture items, exactly four keys, dependencies unmodified", async () => {
    const targets = [target(5), target(6), { kind: "unknown_sender_group" as const, id: id(50) }];
    const req = JSON.stringify({ idempotencyKey: id(4), targets, template });
    const dependencies = { head: "3", generation: id(77) };
    const capture = { items: [captureItem(5, { dependencies }), captureItem(6, { exclusion: "property_unavailable" })] };
    const freeze = freezeResult([freezeItemFor(5, "Hi Ada, I'm Mel."), excludedFreezeItem(6, "property_unavailable"), excludedFreezeItem(50, "unsupported_target", "unknown_sender_group")]);
    const c = client([ok(capture), ok(freeze)]);
    const stringifySpy = vi.spyOn(JSON, "stringify");
    await c.repository.prepare(req, signal());
    expect(c.rpc.mock.calls[0][1]).toEqual({ conversation_ids: [id(5), id(6)] });
    // Reference identity: capture.dependencies flows into the draft object
    // passed to JSON.stringify() UNCHANGED — draftFor() assigns
    // `capture.dependencies` directly (`as Json`), never cloning or
    // reconstructing it, so the exact same object reference reaches the
    // envelope call.
    const envelopeCall = stringifySpy.mock.calls.find(([value]) => value !== null && typeof value === "object" && "drafts" in (value as object));
    expect(envelopeCall).toBeDefined();
    const envelope = envelopeCall![0] as { drafts: { dependencies: unknown }[] };
    expect(envelope.drafts[0].dependencies).toBe(dependencies);
    stringifySpy.mockRestore();
    const rawCanonicalInput = (c.rpc.mock.calls[1][1] as { canonical_input: string }).canonical_input;
    // Verbatim serialization: the exact same key order/content JSON.stringify
    // would produce for `dependencies` alone appears unchanged inside the
    // full envelope string — proof nothing re-derived or reordered it.
    expect(rawCanonicalInput).toContain(JSON.stringify(dependencies));
    const canonicalInput = JSON.parse(rawCanonicalInput);
    expect(canonicalInput.drafts).toHaveLength(1);
    expect(Object.keys(canonicalInput.drafts[0]).sort()).toEqual(["body", "conversationId", "dependencies", "exclusion"]);
    expect(canonicalInput.drafts[0].dependencies).toEqual(dependencies);
    expect(canonicalInput.drafts[0].conversationId).toBe(id(5));
  });
  // MUTATION: adding an extra key to the draft object fails the key-set
  // assertion above. Reconstructing `dependencies` via JSON.parse(JSON.
  // stringify(capture.dependencies)) instead of assigning the raw reference
  // would still pass the `toEqual`/`toContain` checks here (jsonb IS
  // DISTINCT FROM in setup.sql's freeze() compares semantically, so a
  // round-tripped-but-content-identical object is not a correctness bug) —
  // but it WOULD fail the `toBe` reference-identity assertion above, which
  // exists to catch an unnecessary clone/reconstruction, not a safety gap.
});

describe("C7 error mapping table (obligation 8)", () => {
  const rows: [string, string | undefined, number, string][] = [
    ["PGRST301", undefined, 401, "authentication_required"],
    ["PGRST303", undefined, 401, "authentication_required"],
    ["42501", "INBOX_AUTH_REQUIRED", 401, "authentication_required"],
    ["42501", "INBOX_SESSION_EXPIRED", 401, "authentication_required"],
    ["42501", "INBOX_SESSION_REVOKED", 401, "authentication_required"],
    ["42501", "INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING", 403, "access_unavailable"],
    ["42501", "INBOX_ORG_DENIED", 403, "access_unavailable"],
    ["42501", "INBOX_ACTION_FORBIDDEN", 403, "access_unavailable"],
    ["55000", undefined, 404, "Not found"],
    ["P0001", "INBOX_REPLY_PREPARATION_CHANGED", 409, "preparation_changed"],
    ["P0001", "INBOX_REPLY_IDEMPOTENCY_MISMATCH", 409, "idempotency_mismatch"],
    ["P0001", "INBOX_REPLY_PREPARATION_EXPIRED", 409, "preparation_expired"],
    ["P0001", "Invalid reply envelope", 503, "action_unavailable"],
    ["23505", "unique_violation", 503, "action_unavailable"],
  ];
  it.each(rows)("%s/%s -> %d %s", async (code, message, status, expectedCode) => {
    const c = client([{ data: null, error: { code, message } }]);
    await expect(c.repository.prepare(JSON.stringify(request()), signal())).rejects.toMatchObject({ status, code: expectedCode });
  });
  // MUTATION: the 55000 row must map to code "Not found" byte-identical to
  // the flag-off route body (C1) — see reply-route.test.ts for the body
  // equality assertion at the route layer.

  it("retries an aborted capture transaction and renders drafts from the SECOND (fresh) capture, never the stale one", async () => {
    const freshCapture = { items: [captureItem(5, { variables: { ...baseVars, first_name: "Fresh" } })] };
    const freeze = freezeResult([freezeItemFor(5, "Hi Fresh, I'm Mel.")]);
    const c = client([{ data: null, error: { code: "40P01" } }, ok(freshCapture), ok(freeze)]);
    await c.repository.prepare(JSON.stringify(request()), signal());
    expect(c.rpc).toHaveBeenCalledTimes(3);
    const canonicalInput = JSON.parse((c.rpc.mock.calls[2][1] as { canonical_input: string }).canonical_input);
    expect(canonicalInput.drafts[0].body).toBe("Hi Fresh, I'm Mel.");
  });
  // MUTATION: hoisting draft-building above/outside the retry (reading a
  // captured `captureResult` from before the retry resolved) would render
  // "Stale" instead of "Fresh" here.
});

describe("my_first_name sender persona (obligation 9, C4)", () => {
  it("uses OUTBOUND_SENDER_NAME when set, and falls back to Mel when unset", async () => {
    const capture = { items: [captureItem(5)] };
    vi.stubEnv("OUTBOUND_SENDER_NAME", "");
    const c1 = client([ok(capture), ok(freezeResult([freezeItemFor(5, "Hi Ada, I'm Mel.")]))]);
    await c1.repository.prepare(JSON.stringify(request()), signal());
    expect(JSON.parse((c1.rpc.mock.calls[1][1] as { canonical_input: string }).canonical_input).drafts[0].body).toBe("Hi Ada, I'm Mel.");
    vi.stubEnv("OUTBOUND_SENDER_NAME", "Skyler");
    const c2 = client([ok(capture), ok(freezeResult([freezeItemFor(5, "Hi Ada, I'm Skyler.")]))]);
    await c2.repository.prepare(JSON.stringify(request()), signal());
    expect(JSON.parse((c2.rpc.mock.calls[1][1] as { canonical_input: string }).canonical_input).drafts[0].body).toBe("Hi Ada, I'm Skyler.");
  });
});

describe("UTF-16 template/body boundaries propagate through the coordinator (obligation 10)", () => {
  const astral = "\u{1D555}"; // 2 UTF-16 units
  it("accepts a template at exactly 1600 UTF-16 units (including astral chars) and rejects one unit over", async () => {
    const atLimit = astral.repeat(800); // 1600 units
    const overLimit = astral.repeat(801); // 1602 units
    const req = (t: string) => JSON.stringify({ idempotencyKey: id(4), targets: [{ kind: "unknown_sender_group", id: id(50) }], template: t });
    const c1 = client([ok(freezeResult([excludedFreezeItem(50, "unsupported_target", "unknown_sender_group")], { blockers: ["empty"] }))]);
    await expect(c1.repository.prepare(req(atLimit), signal())).resolves.toBeDefined();
    const c2 = client([]);
    await expect(c2.repository.prepare(req(overLimit), signal())).rejects.toMatchObject({ status: 400, code: "invalid_template" });
    expect(c2.rpc).not.toHaveBeenCalled();
  });
  it("treats a per-recipient render that collapses to whitespace-only (U+3000/U+FEFF) as an invalid_body draft exclusion, not a template-wide 400", async () => {
    // Probe (first_name="x", non-empty) renders the conditional block, so the
    // template itself is valid. A real recipient with a missing first_name
    // silently skips the conditional (no throw), leaving only the trailing
    // U+3000/U+FEFF static text — which trims to empty, so THIS recipient's
    // real render throws invalid_body although the probe never did.
    const templateWithConditional = "{{#if first_name}}{{first_name}}{{/if}}　﻿";
    const capture = { items: [captureItem(5, { variables: { ...baseVars, first_name: null } })] };
    const freeze = freezeResult([excludedFreezeItem(5, "invalid_body")], { blockers: ["empty"] });
    const c = client([ok(capture), ok(freeze)]);
    const result = await c.repository.prepare(JSON.stringify({ idempotencyKey: id(4), targets: [target(5)], template: templateWithConditional }), signal());
    expect(result.items[0].exclusion).toBe("invalid_body");
    const canonicalInput = JSON.parse((c.rpc.mock.calls[1][1] as { canonical_input: string }).canonical_input);
    expect(canonicalInput.drafts[0]).toEqual({ conversationId: id(5), body: null, dependencies: { head: "1" }, exclusion: "invalid_body" });
  });
  // MUTATION: catching only "missing_variable" (not "invalid_body") in
  // draftFor's per-recipient try/catch lets this whitespace-only render throw
  // uncaught instead of becoming a draft exclusion.
});

describe("abort handling (obligation 11)", () => {
  it("passes the same abort signal to both the capture and freeze rpc calls", async () => {
    const capture = { items: [captureItem(5)] };
    const freeze = freezeResult([freezeItemFor(5, "Hi Ada, I'm Mel.")]);
    const c = client([ok(capture), ok(freeze)]);
    const s = signal();
    await c.repository.prepare(JSON.stringify(request()), s);
    expect(c.seenSignals).toEqual([s, s]);
  });
  it("never calls freeze once the signal aborts right after capture resolves", async () => {
    const capture = { items: [captureItem(5)] };
    const controller = new AbortController();
    const captureAbortSignal = vi.fn(async () => {
      const result = ok(capture);
      controller.abort();
      return result;
    });
    const freezeAbortSignal = vi.fn(async () => ok(freezeResult([])));
    const rpc = vi.fn((name: string) => ({
      abortSignal: name === "inbox_capture_reply_recipients" ? captureAbortSignal : freezeAbortSignal,
    }));
    const repository = createInboxReplyRepository({ rpc } as unknown as InboxReplyClient);
    await expect(repository.prepare(JSON.stringify(request()), controller.signal)).rejects.toThrow();
    // The freeze mock itself — not just an inference from total call count —
    // must never have been invoked.
    expect(freezeAbortSignal).not.toHaveBeenCalled();
    expect(captureAbortSignal).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith("inbox_freeze_reply_review", expect.anything());
  });
  // MUTATION: dropping the `signal.throwIfAborted()` call immediately after
  // the capture RPC resolves lets freeze run even though the caller aborted.
});
