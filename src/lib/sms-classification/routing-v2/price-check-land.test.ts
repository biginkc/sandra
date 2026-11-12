import { describe, expect, it, vi } from "vitest";

import {
  dealMachineShape,
  fetchDealMachineEstimatedValue,
  parseDealMachineEnrichResponse,
} from "@/lib/comps/providers/dealmachine";

import { V2_ALERT_LABELS, V2_PRICE_CHECK_ACTIONS } from "./actions";
import { lookupDealMachineValue, type DealMachineCacheStore } from "./dealmachine-value";
import { ALL_OFF, type RoutingV2Flags } from "./flags";
import { runV2PriceCheck } from "./price-check";
import type { PropertyTypeOption } from "./questions";
import type { V2Decision } from "./route";

/** Jarrad 2026-11-11: DealMachine land → vacant-lot alert to him, no 80% check, no seller reply. */
const PROP = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ON: RoutingV2Flags = { ...ALL_OFF, questions_live: true, price_check: true, canaryPropertyIds: new Set([PROP]) };
const DECISION: V2Decision = {
  road: "price_check",
  provenance: { by: "jev", row: "11", step: "price", signal: "named_price", probability: 0.9 },
  haiku: null,
  opportunityAlert: false,
};
const PT: Record<PropertyTypeOption, number> = { residential: 0.9, lot: 0.01, commercial: 0.01, rental: 0.01, didnt_say: 0.05 };
const LAND_ALERT = { road: "ALERT_land_price", steps: [{ kind: "alert", reason: "land_price" }] };

const check = (reply: string, isLand: boolean | null | undefined, value = 231_000) =>
  runV2PriceCheck({
    flags: ON, propertyId: PROP, decision: DECISION, reply, propertyType: PT,
    lookupValue: async () => ({ kind: "value", value, source: "provider", isLand }),
  });

describe("land detection from the DealMachine record", () => {
  it("200 NW 81st shape (0 sq ft, 0 bedrooms) is land; a house is not", () => {
    expect(dealMachineShape({ living_area_sqft: 0, num_bedrooms: 0 }).isLand).toBe(true);
    expect(dealMachineShape({ living_area_sqft: null, num_bedrooms: null }).isLand).toBe(true);
    expect(dealMachineShape({ living_area_sqft: 0, num_bedrooms: null }).isLand).toBe(true);
    expect(dealMachineShape({ living_area_sqft: 1240, num_bedrooms: 3 }).isLand).toBe(false);
    expect(dealMachineShape({ living_area_sqft: 0, num_bedrooms: 2 }).isLand).toBe(false);
    expect(dealMachineShape({ living_area_sqft: "980", num_bedrooms: 0 }).isLand).toBe(false);
  });

  it("neither field in the response → unknown, never land", () => {
    expect(dealMachineShape({ estimated_value: 231000 }).isLand).toBeNull();
    expect(parseDealMachineEnrichResponse({ data: [{ matched: true, estimated_value: 231000 }] })).toEqual({ kind: "ok", value: 231000 });
  });

  it("malformed shape values → unknown, never land", () => {
    expect(dealMachineShape({ living_area_sqft: "unknown", num_bedrooms: 0 }).isLand).toBeNull();
    expect(dealMachineShape({ living_area_sqft: 0, num_bedrooms: -1 }).isLand).toBeNull();
    expect(dealMachineShape({ living_area_sqft: {}, num_bedrooms: 0 }).isLand).toBeNull();
  });

  it.each([null, 0])("matched land with no usable value (%s) keeps the land signal", (estimated_value) => {
    expect(parseDealMachineEnrichResponse({ data: [{ matched: true, estimated_value, living_area_sqft: 0, num_bedrooms: 0 }] })).toEqual({
      kind: "no_value", reason: "no_estimated_value", shape: { livingAreaSqft: 0, numBedrooms: 0, isLand: true },
    });
    expect(parseDealMachineEnrichResponse({ data: [{ matched: true, estimated_value }] })).toEqual({ kind: "no_value", reason: "no_estimated_value" });
  });

  it("parses the shape from the same response as the value", () => {
    const r = parseDealMachineEnrichResponse({
      data: [{ matched: true, estimated_value: 231000, living_area_sqft: 0, num_bedrooms: 0, total_assessed_value: 5320 }],
    });
    expect(r).toEqual({ kind: "ok", value: 231000, shape: { livingAreaSqft: 0, numBedrooms: 0, isLand: true } });
  });

  it("one HTTP request asks for the value and the two shape fields together", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ matched: true, estimated_value: 231000, living_area_sqft: 0, num_bedrooms: 0 }], credits: { used: 1 } }), { status: 200 }));
    const r = await fetchDealMachineEstimatedValue({ street: "200 NW 81st St", city: "Kansas City", state: "MO" }, {
      apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, beforeAttempt: async () => "id", onAttempt: async () => {},
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).fields).toEqual(["estimated_value", "living_area_sqft", "num_bedrooms"]);
    expect(r).toMatchObject({ kind: "ok", shape: { isLand: true } });
  });
});

describe("price check with a DealMachine land signal", () => {
  it("land + $55k ask on a $240k value → vacant-lot alert only, no seller reply, no 80% check", async () => {
    const r = await check("I'd take $55k", true, 240_000);
    expect(r.outcome).toBe("land_price");
    expect(r.action).toEqual(LAND_ALERT);
    expect(r.action.steps.some((s) => s.kind === "reply")).toBe(false);
    expect(r.value).toBe(240_000);
  });

  it("land even when the ask is above 80% → still the alert, never the repairs reply", async () => {
    const r = await check("$230,000", true, 231_000);
    expect(r.action).toEqual(LAND_ALERT);
  });

  it("land with no DealMachine value → still the vacant-lot alert, no fair-price reply", async () => {
    const r = await runV2PriceCheck({
      flags: ON, propertyId: PROP, decision: DECISION, reply: "$50k", propertyType: PT,
      lookupValue: async () => ({ kind: "no_value", reason: "cached_negative", isLand: true }),
    });
    expect(r).toMatchObject({ outcome: "land_price", action: LAND_ALERT, value: null });
  });

  it("the alert Jarrad sees says vacant lot", () => {
    expect(V2_ALERT_LABELS.land_price.toLowerCase()).toContain("vacant lot");
  });

  it.each([false, null, undefined])("not land / unknown (%s) → today's behaviour", async (isLand) => {
    expect(await check("$50k", isLand, 240_000)).toMatchObject({ outcome: "fair", action: { road: "price_check", steps: V2_PRICE_CHECK_ACTIONS.fair_or_no_value } });
    expect(await check("$230k", isLand, 240_000)).toMatchObject({ outcome: "too_high", action: { road: "price_check", steps: V2_PRICE_CHECK_ACTIONS.too_high } });
  });
});

describe("cache carries the land signal", () => {
  const ADDR = { street: "200 NW 81st St", city: "Kansas City", state: "MO", zip: null };
  const ledger = { startAttempt: async () => "call1", settleAttempt: async () => true };

  it("provider answer: shape recorded for the claim before settle, and returned", async () => {
    const order: string[] = [];
    const recordShape = vi.fn(async () => (order.push("shape"), true));
    const store: DealMachineCacheStore = {
      ...ledger,
      claim: async () => ({ outcome: "claimed", claimToken: "tok" }),
      settle: async () => (order.push("settle"), true),
      recordShape,
    };
    const r = await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, {
      store,
      callProvider: async () => ({ kind: "ok", value: 231000, shape: { livingAreaSqft: 0, numBedrooms: 0, isLand: true } }),
    });
    expect(r).toEqual({ kind: "value", value: 231000, source: "provider", isLand: true });
    expect(recordShape).toHaveBeenCalledWith({ propertyId: PROP, claimToken: "tok", shape: { livingAreaSqft: 0, numBedrooms: 0, isLand: true } });
    expect(order).toEqual(["shape", "settle"]);
  });

  it("matched land with no value: shape recorded, negative cached, land returned; cached negative carries it", async () => {
    const recordShape = vi.fn(async () => true);
    const settle = vi.fn(async () => true);
    const shape = { livingAreaSqft: 0, numBedrooms: 0, isLand: true };
    const store: DealMachineCacheStore = { ...ledger, claim: async () => ({ outcome: "claimed", claimToken: "tok" }), settle, recordShape };
    const r = await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, {
      store, callProvider: async () => ({ kind: "no_value", reason: "no_estimated_value", shape }),
    });
    expect(r).toEqual({ kind: "no_value", reason: "no_estimated_value", isLand: true });
    expect(recordShape).toHaveBeenCalledWith({ propertyId: PROP, claimToken: "tok", shape });
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ state: "negative" }));
    const cached: DealMachineCacheStore = { ...ledger, claim: async () => ({ outcome: "cached_negative", isLand: true }), settle };
    expect(await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store: cached, callProvider: vi.fn() }))
      .toEqual({ kind: "no_value", reason: "cached_negative", isLand: true });
  });

  it("storing the shape fails (migration not applied) → value and this call's land answer still used", async () => {
    const store: DealMachineCacheStore = {
      ...ledger,
      claim: async () => ({ outcome: "claimed", claimToken: "tok" }),
      settle: async () => true,
      recordShape: async () => {
        throw new Error("rpc missing");
      },
    };
    const r = await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, {
      store, callProvider: async () => ({ kind: "ok", value: 231000, shape: { livingAreaSqft: 0, numBedrooms: 0, isLand: true } }),
    });
    expect(r).toMatchObject({ kind: "value", isLand: true });
  });

  it("cached rows: stored land is used; rows from before the signal are unknown and never re-billed", async () => {
    const callProvider = vi.fn();
    for (const [isLand, want] of [[true, { isLand: true }], [false, { isLand: false }], [null, {}], [undefined, {}]] as const) {
      const store: DealMachineCacheStore = { ...ledger, claim: async () => ({ outcome: "cached_ok", value: 231000, isLand }), settle: async () => true };
      expect(await lookupDealMachineValue({ orgId: ORG, propertyId: PROP, address: ADDR }, { store, callProvider }))
        .toEqual({ kind: "value", value: 231000, source: "cache", ...want });
    }
    expect(callProvider).not.toHaveBeenCalled();
  });
});
