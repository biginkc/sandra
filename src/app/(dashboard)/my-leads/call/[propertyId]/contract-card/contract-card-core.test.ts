import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  createContractCardCore,
  submissionHashOf,
  type ContractCardCoreDeps,
  type ExistingOfferIntent,
  type SendContractCardInput,
} from "./contract-card-core";
import { BUYER, novationBase, NOW, TEST_ONLY_EARNEST_MONEY_CENTS, TITLE } from "./fixtures";

const PROPERTY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEMPLATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INTENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const input = (over: Partial<SendContractCardInput> = {}): SendContractCardInput => ({
  propertyId: PROPERTY, templateId: TEMPLATE, sendIntentId: INTENT, priceCents: 21000000, closingDate: "2099-01-02",
  titleCompanyId: TITLE.id, buyerEntityId: BUYER.id, earnestMoneyCents: TEST_ONLY_EARNEST_MONEY_CENTS, overrides: {},
  signers: [
    { role: "Seller", order: 0, name: "Sam Seller", emailAddress: "sam@example.test" },
    { role: "Buyer", order: 1, name: "Test Buyer LLC", emailAddress: "buyer@example.test" },
  ],
  ...over,
});

function setup(over: Partial<ContractCardCoreDeps> = {}, viewer = { userId: USER, orgId: "o", isOwner: false }) {
  const sendSpy = vi.fn(async (i: { sendIntentId: string }) => ({ ok: true as const, data: { requestId: `req-${i.sendIntentId}` } }));
  const projection = {
    resolveIntent: vi.fn(async () => null as ExistingOfferIntent | null),
    precheck: vi.fn(async () => ({ ok: true as const })),
    createIntent: vi.fn(async () => ({ projectionId: "proj-1" })),
    projectNow: vi.fn(async () => ({ state: "pending" as const })),
    abandon: vi.fn(async () => undefined),
  };
  const deps: ContractCardCoreDeps = {
    viewer: async () => viewer,
    flagOn: async () => true,
    projectionReady: async () => true,
    ownsLead: async () => true,
    loadContext: async () => ({
      prefillBase: { ...novationBase(), comp: { ...novationBase().comp!, fetchedAt: new Date(Date.now() - 86400000).toISOString() } },
      titleCompanies: [TITLE], buyerEntities: [BUYER], todayCentral: "2026-10-04", tomorrowCentral: "2026-10-05",
    }),
    projection,
    send: sendSpy,
    ...over,
  };
  void NOW;
  return { core: createContractCardCore(deps), deps, projection, sendSpy };
}

describe("sendContractCard", () => {
  it("is blocked FEATURE_DISABLED when the flag is off, before anything else runs", async () => {
    const { core, projection, sendSpy } = setup({ flagOn: async () => false });
    expect(await core.sendContractCard(input())).toMatchObject({ status: "blocked", code: "FEATURE_DISABLED" });
    expect(projection.resolveIntent).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("is blocked FEATURE_DISABLED when the offer projection schema is not ready", async () => {
    const { core, sendSpy } = setup({ projectionReady: async () => false });
    expect(await core.sendContractCard(input())).toMatchObject({ status: "blocked", code: "FEATURE_DISABLED" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses a lead outside the caller's own queue", async () => {
    const { core, sendSpy } = setup({ ownsLead: async () => false });
    expect(await core.sendContractCard(input())).toMatchObject({ status: "blocked", code: "NOT_IN_QUEUE" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses a missing earnest money server-side (no default), before any intent or send", async () => {
    const { core, projection, sendSpy } = setup();
    for (const v of [null, undefined]) {
      expect(await core.sendContractCard(input({ earnestMoneyCents: v as never }))).toMatchObject({ status: "blocked", code: "EARNEST_MONEY_MISSING" });
    }
    expect(projection.createIntent).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed input and extra keys", async () => {
    const { core, sendSpy } = setup();
    expect(await core.sendContractCard({ ...input(), extra: 1 } as never)).toMatchObject({ code: "INVALID_INPUT" });
    expect(await core.sendContractCard(input({ priceCents: 0 }))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await core.sendContractCard(input({ sendIntentId: "nope" }))).toMatchObject({ code: "INVALID_INPUT" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses to send while the title company or buyer entity is missing from the org's defaults", async () => {
    const empty = setup({ loadContext: async () => ({ prefillBase: novationBase(), titleCompanies: [], buyerEntities: [], todayCentral: "2026-10-04", tomorrowCentral: "2026-10-05" }) });
    expect(await empty.core.sendContractCard(input())).toMatchObject({ status: "blocked", code: "TITLE_COMPANY_MISSING" });
    expect(empty.sendSpy).not.toHaveBeenCalled();
    expect(empty.projection.createIntent).not.toHaveBeenCalled();
  });

  it("rejects economic overrides and past closing dates before any intent exists", async () => {
    const { core, projection, sendSpy } = setup();
    expect(await core.sendContractCard(input({ overrides: { offer_price: "$1.00" } }))).toMatchObject({ code: "ECONOMIC_OVERRIDE" });
    expect(await core.sendContractCard(input({ closingDate: "2026-10-04" }))).toMatchObject({ code: "CLOSING_DATE_PAST" });
    expect(projection.createIntent).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("blocks incomplete signers and missing fields (no legal description) before sending", async () => {
    const a = setup();
    expect(await a.core.sendContractCard(input({ signers: [{ role: "Seller", order: 0, name: "", emailAddress: "" }] }))).toMatchObject({ code: "SIGNER_INCOMPLETE" });
    const b = setup({ loadContext: async () => ({ prefillBase: novationBase({ comp: null }), titleCompanies: [TITLE], buyerEntities: [BUYER], todayCentral: "2026-10-04", tomorrowCentral: "2026-10-05" }) });
    expect(await b.core.sendContractCard(input())).toMatchObject({ code: "MISSING_FIELDS" });
    expect(b.sendSpy).not.toHaveBeenCalled();
  });

  it("sends once for a new intent with the server-built payload and projects the offer", async () => {
    const { core, projection, sendSpy } = setup();
    const res = await core.sendContractCard(input());
    expect(res).toEqual({ status: "sent", requestId: `req-${INTENT}`, offer: "pending" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0]![0] as unknown as { mergeValues: Record<string, string> };
    expect(sent.mergeValues.offer_price).toBe("$210,000.00");
    expect(sent.mergeValues.earnest_money_holder).toBe("Test Title Co");
    expect(projection.createIntent).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 21000000, closingDate: "2099-01-02", sendIntentId: INTENT }));
    expect(projection.projectNow).toHaveBeenCalledWith("proj-1");
  });

  it("maps a conflict from projection to offer:'conflict' without a second send", async () => {
    const { core, projection, sendSpy } = setup();
    projection.projectNow.mockResolvedValueOnce({ state: "conflict" as never, code: "PENDING_OFFER_EXISTS" } as never);
    expect(await core.sendContractCard(input())).toMatchObject({ status: "sent", offer: "conflict", code: "PENDING_OFFER_EXISTS" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["SEND_UNKNOWN", "SEND_IN_PROGRESS"])("returns unconfirmed on %s, logs no offer and never abandons the intent", async (code) => {
    const { core, projection } = setup({ send: async () => ({ ok: false, error: { code, message: "x" } }) });
    expect(await core.sendContractCard(input())).toEqual({ status: "unconfirmed", projectionId: "proj-1" });
    expect(projection.projectNow).not.toHaveBeenCalled();
    expect(projection.abandon).not.toHaveBeenCalled();
  });

  it("definitive failure returns failed, logs nothing and releases the open slot", async () => {
    const { core, projection } = setup({ send: async () => ({ ok: false, error: { code: "SEND_FAILED", message: "provider said no" } }) });
    expect(await core.sendContractCard(input())).toEqual({ status: "failed", message: "provider said no", definitive: true });
    expect(projection.projectNow).not.toHaveBeenCalled();
    expect(projection.abandon).toHaveBeenCalledWith("proj-1");
  });

  it("projectNow throwing after a successful send returns sent (offer pending), never a plain failure", async () => {
    const { core, projection, sendSpy } = setup();
    projection.projectNow.mockRejectedValueOnce(new Error("db down"));
    expect(await core.sendContractCard(input())).toEqual({ status: "sent", requestId: `req-${INTENT}`, offer: "pending", code: "PROJECTION_ERROR" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(projection.abandon).not.toHaveBeenCalled();
  });

  it("send throwing (provider call may have happened) returns unconfirmed and keeps the intent", async () => {
    const { core, projection } = setup({ send: async () => { throw new Error("socket hang up"); } });
    expect(await core.sendContractCard(input())).toEqual({ status: "unconfirmed", projectionId: "proj-1" });
    expect(projection.abandon).not.toHaveBeenCalled();
    expect(projection.projectNow).not.toHaveBeenCalled();
  });

  it("a failing abandon after a definitive send failure still reports failed", async () => {
    const { core, projection } = setup({ send: async () => ({ ok: false, error: { code: "SEND_FAILED", message: "no" } }) });
    projection.abandon.mockRejectedValueOnce(new Error("x"));
    expect(await core.sendContractCard(input())).toMatchObject({ status: "failed", definitive: true });
  });

  it("rejects an inactive title company or buyer entity server-side, before any intent exists", async () => {
    const mk = (t: boolean, b: boolean) => setup({ loadContext: async () => ({
      prefillBase: { ...novationBase(), comp: { ...novationBase().comp!, fetchedAt: new Date(Date.now() - 86400000).toISOString() } },
      titleCompanies: [{ ...TITLE, isActive: t }], buyerEntities: [{ ...BUYER, isActive: b }], todayCentral: "2026-10-04", tomorrowCentral: "2026-10-05",
    }) });
    const a = mk(false, true);
    expect(await a.core.sendContractCard(input())).toMatchObject({ status: "blocked", code: "TITLE_COMPANY_MISSING" });
    const b = mk(true, false);
    expect(await b.core.sendContractCard(input())).toMatchObject({ status: "blocked", code: "BUYER_ENTITY_MISSING" });
    for (const x of [a, b]) { expect(x.projection.createIntent).not.toHaveBeenCalled(); expect(x.sendSpy).not.toHaveBeenCalled(); }
    expect((await mk(true, true).core.sendContractCard(input())).status).toBe("sent");
  });

  it("maps createIntent errors without sending", async () => {
    const { core, projection, sendSpy } = setup();
    projection.createIntent.mockResolvedValueOnce({ error: "OPEN_CONTRACT_EXISTS" } as never);
    expect(await core.sendContractCard(input())).toMatchObject({ status: "blocked", code: "OPEN_CONTRACT_EXISTS" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("surfaces precheck rejections", async () => {
    const { core, projection, sendSpy } = setup();
    projection.precheck.mockResolvedValueOnce({ ok: false, code: "PENDING_OFFER_EXISTS", message: "pending" } as never);
    expect(await core.sendContractCard(input())).toMatchObject({ code: "PENDING_OFFER_EXISTS" });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("idempotent send key (replay)", () => {
  const existing = (over: Partial<ExistingOfferIntent> = {}): ExistingOfferIntent => ({
    projectionId: "proj-1", actorUserId: USER, requestHash: "h", submissionHash: submissionHashOf(input()),
    sendPayload: { stored: "payload" }, state: "awaiting_send", esignRequestId: null, ...over,
  });

  it("replays the stored payload with the same intent, skipping precheck and createIntent", async () => {
    const { core, projection, sendSpy } = setup();
    projection.resolveIntent.mockResolvedValue(existing());
    const res = await core.sendContractCard(input());
    expect(res.status).toBe("sent");
    expect(projection.precheck).not.toHaveBeenCalled();
    expect(projection.createIntent).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ sendIntentId: INTENT, mergeValues: { stored: "payload" } }));
  });

  it("returns the durable result for a logged projection without any send", async () => {
    const { core, projection, sendSpy } = setup();
    projection.resolveIntent.mockResolvedValue(existing({ state: "logged", esignRequestId: "req-9" }));
    expect(await core.sendContractCard(input())).toEqual({ status: "sent", requestId: "req-9", offer: "logged" });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(projection.precheck).not.toHaveBeenCalled();
  });

  it("a replay with a changed price is IDEMPOTENCY_CONFLICT", async () => {
    const { core, projection, sendSpy } = setup();
    projection.resolveIntent.mockResolvedValue(existing());
    expect(await core.sendContractCard(input({ priceCents: 1 }))).toMatchObject({ status: "blocked", code: "IDEMPOTENCY_CONFLICT" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses a different non-owner user but allows an owner", async () => {
    const other = { userId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", orgId: "o", isOwner: false };
    const a = setup({}, other);
    a.projection.resolveIntent.mockResolvedValue(existing());
    expect(await a.core.sendContractCard(input())).toMatchObject({ status: "blocked", code: "FORBIDDEN" });
    expect(a.sendSpy).not.toHaveBeenCalled();
    const b = setup({}, { ...other, isOwner: true });
    b.projection.resolveIntent.mockResolvedValue(existing({ state: "logged", esignRequestId: "r" }));
    expect((await b.core.sendContractCard(input())).status).toBe("sent");
  });

  it("the submission hash is order-insensitive for overrides and signers' key order", () => {
    expect(submissionHashOf(input({ overrides: { additional_terms: "a", due_diligence_days: "1" } })))
      .toBe(submissionHashOf(input({ overrides: { due_diligence_days: "1", additional_terms: "a" } })));
    expect(submissionHashOf(input())).not.toBe(submissionHashOf(input({ closingDate: "2099-01-03" })));
  });
});

describe("static import guard", () => {
  it("no card module imports send-contract or website-template-registration", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["'][^"']*(send-contract|website-template-registration)["']/);
    }
  });
});
