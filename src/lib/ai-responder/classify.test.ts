import { describe, expect, it } from "vitest";

import { classifyAiSkip, type SkipInput } from "./classify";

const BASE: SkipInput = {
  config: {
    active: true,
    business_hours_only: true,
    max_turns: 3,
    daily_send_cap: 100,
  },
  consentState: "can_send_marketing",
  propertyDisabled: false,
  currentTurn: 0,
  orgSendsToday: 0,
  withinBusinessHours: true,
};

describe("classifyAiSkip", () => {
  it("all green → skip:false", () => {
    expect(classifyAiSkip(BASE)).toEqual({ skip: false });
  });

  it("no config → skip, reason no_config", () => {
    expect(classifyAiSkip({ ...BASE, config: null })).toEqual({
      skip: true,
      reason: "no_config",
    });
  });

  it("config.active=false → disabled_org_wide", () => {
    expect(
      classifyAiSkip({
        ...BASE,
        config: { ...BASE.config!, active: false },
      }),
    ).toEqual({ skip: true, reason: "disabled_org_wide" });
  });

  it("contact opted_out → no_consent", () => {
    expect(classifyAiSkip({ ...BASE, consentState: "opted_out" })).toEqual({
      skip: true,
      reason: "no_consent",
    });
  });

  it("contact with no_consent (never opted in) → no_consent", () => {
    expect(classifyAiSkip({ ...BASE, consentState: "no_consent" })).toEqual({
      skip: true,
      reason: "no_consent",
    });
  });

  it("property disabled → disabled_per_property", () => {
    expect(classifyAiSkip({ ...BASE, propertyDisabled: true })).toEqual({
      skip: true,
      reason: "disabled_per_property",
    });
  });

  it("daily cap hit → daily_cap", () => {
    expect(classifyAiSkip({ ...BASE, orgSendsToday: 100 })).toEqual({
      skip: true,
      reason: "daily_cap",
    });
  });

  it("daily cap exceeded → daily_cap", () => {
    expect(classifyAiSkip({ ...BASE, orgSendsToday: 250 })).toEqual({
      skip: true,
      reason: "daily_cap",
    });
  });

  it("max turns reached → max_turns_reached", () => {
    expect(classifyAiSkip({ ...BASE, currentTurn: 3 })).toEqual({
      skip: true,
      reason: "max_turns_reached",
    });
  });

  it("business_hours_only true + outside window → outside_business_hours", () => {
    expect(classifyAiSkip({ ...BASE, withinBusinessHours: false })).toEqual({
      skip: true,
      reason: "outside_business_hours",
    });
  });

  it("business_hours_only false + outside window → do NOT skip (AI can reply, send pipeline blocks if needed)", () => {
    expect(
      classifyAiSkip({
        ...BASE,
        config: { ...BASE.config!, business_hours_only: false },
        withinBusinessHours: false,
      }),
    ).toEqual({ skip: false });
  });
});
