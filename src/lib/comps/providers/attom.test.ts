import { describe, expect, it } from "vitest";

import fixture from "../__fixtures__/attom-avm-detail.json";
import { CompProviderError, type CompSubject } from "../types";
import { createAttomProvider, mapAvmDetail, mapLegal, ATTOM_AVM_PATH, ATTOM_COMPS_PATH } from "./attom";

const subject: CompSubject = {
  propertyId: "11111111-1111-4111-8111-111111111111", orgId: "o", address: "100 Sample Ave", city: "Sample City",
  state: "MO", zip: "64000", attomId: null, fips: null, apn: null, sqft: 1240, beds: 3, baths: 1, yearBuilt: 1952, lat: null, lon: null,
};

type Route = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number; text?: string };
function fakeFetch(routes: Record<string, Route>, calls: string[] = []) {
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const route = Object.entries(routes).find(([prefix]) => url.pathname.startsWith(prefix))?.[1] ?? { status: 404, body: {} };
    if (route.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, route.delayMs);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
      });
    }
    const text = route.text ?? JSON.stringify(route.body ?? {});
    return new Response(text, { status: route.status, headers: route.headers });
  };
  return { impl, calls };
}
const provider = (routes: Record<string, Route>, calls?: string[], timeout = 8000) =>
  createAttomProvider({ apiKey: "test-key", baseUrl: "https://attom.test", fetchImpl: fakeFetch(routes, calls).impl, requestTimeoutMs: timeout });

describe("mapAvmDetail (recorded shape, synthetic values)", () => {
  it("maps value, range, score, fsd, owner, legal and the attom id", () => {
    const m = mapAvmDetail(fixture);
    expect(m.attomId).toBe("100000001");
    expect(m.asIs).toEqual({ value: 185000, low: 166500, high: 203500, score: 82, fsdPct: 10 });
    expect(m.ownerOfRecord).toBe("SAMPLE OWNER ONE & SAMPLE OWNER TWO");
    expect(m.legal).toEqual({ text: "SAMPLE HEIGHTS BLK 4 LOT 12 EXC N 5FT", complete: true });
  });
  it("derives fsd from the range when ATTOM omits it", () => {
    const body = structuredClone(fixture) as typeof fixture;
    delete (body.property[0].avm.amount as { fsd?: number }).fsd;
    expect(mapAvmDetail(body).asIs.fsdPct).toBeCloseTo(10, 5);
  });
  it("falls back to subdivision + lot only when both exist, else no legal", () => {
    expect(mapLegal({ area: { subdname: "SAMPLE HEIGHTS" }, lot: { lotnum: "12" } })).toEqual({ text: "SAMPLE HEIGHTS LOT 12", complete: false });
    expect(mapLegal({ area: { subdname: "SAMPLE HEIGHTS" } })).toEqual({ text: null, complete: false });
    expect(mapLegal({ summary: { legal1: "SAMPLE HEIGHTS" } })).toEqual({ text: "SAMPLE HEIGHTS", complete: false });
  });
  it("no AVM block → nulls (normalize marks it low / verify_first)", () => {
    const body = structuredClone(fixture) as unknown as { property: Record<string, unknown>[] };
    delete body.property[0].avm;
    expect(mapAvmDetail(body).asIs).toEqual({ value: null, low: null, high: null, score: null, fsdPct: null });
  });
});

describe("createAttomProvider", () => {
  it("happy path: AVM by address then comps by propid; comps 403 = not entitled, not an error", async () => {
    const calls: string[] = [];
    const p = provider({ [ATTOM_AVM_PATH]: { status: 200, body: fixture }, [ATTOM_COMPS_PATH]: { status: 403, body: {} } }, calls);
    const r = await p.fetch(subject, new AbortController().signal);
    expect(calls[0]).toContain("address1=100+Sample+Ave");
    expect(calls[0]).toContain("address2=Sample+City%2C+MO+64000");
    expect(calls[1]).toContain(`${ATTOM_COMPS_PATH}/100000001`);
    expect(r.billedCalls).toBe(2);
    expect(r.asIs.value).toBe(185000);
    expect(r.comps).toEqual([]);
    expect(r.raw.compsStatus).toBe("not_entitled");
    expect(r.providerPropertyId).toBe("100000001");
  });
  it("uses attomid when the lead carries one", async () => {
    const calls: string[] = [];
    const p = provider({ [ATTOM_AVM_PATH]: { status: 200, body: fixture }, [ATTOM_COMPS_PATH]: { status: 404 } }, calls);
    await p.fetch({ ...subject, attomId: "100000001" }, new AbortController().signal);
    expect(calls[0]).toContain("attomid=100000001");
  });
  it("401 → AUTH with billedCalls 1", async () => {
    const err = await provider({ [ATTOM_AVM_PATH]: { status: 401, body: {} } }).fetch(subject, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(CompProviderError);
    expect(err.code).toBe("AUTH");
    expect(err.billedCalls).toBe(1);
  });
  it("429 → RATE_LIMIT with Retry-After", async () => {
    const err = await provider({ [ATTOM_AVM_PATH]: { status: 429, body: {}, headers: { "retry-after": "30" } } }).fetch(subject, new AbortController().signal).catch((e) => e);
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.retryAfterSec).toBe(30);
  });
  it("404 / empty property → NOT_FOUND; 5xx → UPSTREAM; bad JSON → INVALID_RESPONSE", async () => {
    expect((await provider({ [ATTOM_AVM_PATH]: { status: 404 } }).fetch(subject, new AbortController().signal).catch((e) => e)).code).toBe("NOT_FOUND");
    expect((await provider({ [ATTOM_AVM_PATH]: { status: 200, body: { property: [] } } }).fetch(subject, new AbortController().signal).catch((e) => e)).code).toBe("NOT_FOUND");
    expect((await provider({ [ATTOM_AVM_PATH]: { status: 503 } }).fetch(subject, new AbortController().signal).catch((e) => e)).code).toBe("UPSTREAM");
    expect((await provider({ [ATTOM_AVM_PATH]: { status: 200, text: "<html>" } }).fetch(subject, new AbortController().signal).catch((e) => e)).code).toBe("INVALID_RESPONSE");
  });
  it("timeout aborts and reports billedCalls", async () => {
    const err = await provider({ [ATTOM_AVM_PATH]: { status: 200, body: fixture, delayMs: 500 } }, [], 20).fetch(subject, new AbortController().signal).catch((e) => e);
    expect(err.code).toBe("TIMEOUT");
    expect(err.billedCalls).toBe(1);
  });
  it("missing address → NOT_FOUND with zero calls", async () => {
    const calls: string[] = [];
    const err = await provider({}, calls).fetch({ ...subject, address: "" }, new AbortController().signal).catch((e) => e);
    expect(err.code).toBe("NOT_FOUND");
    expect(calls).toHaveLength(0);
  });
});
