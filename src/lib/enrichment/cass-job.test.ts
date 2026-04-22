import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAutotriggerCap, isAwaitingManualStart } from "./cass-job";

describe("getAutotriggerCap", () => {
  const original = process.env.CASS_AUTOTRIGGER_MAX_ITEMS;

  beforeEach(() => {
    delete process.env.CASS_AUTOTRIGGER_MAX_ITEMS;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CASS_AUTOTRIGGER_MAX_ITEMS;
    } else {
      process.env.CASS_AUTOTRIGGER_MAX_ITEMS = original;
    }
  });

  it("defaults to 100 when the env var is unset", () => {
    expect(getAutotriggerCap()).toBe(100);
  });

  it("honors a positive integer value", () => {
    process.env.CASS_AUTOTRIGGER_MAX_ITEMS = "500";
    expect(getAutotriggerCap()).toBe(500);
  });

  it("truncates fractional values", () => {
    process.env.CASS_AUTOTRIGGER_MAX_ITEMS = "250.9";
    expect(getAutotriggerCap()).toBe(250);
  });

  it("falls back to the default for non-numeric or non-positive values", () => {
    process.env.CASS_AUTOTRIGGER_MAX_ITEMS = "nope";
    expect(getAutotriggerCap()).toBe(100);
    process.env.CASS_AUTOTRIGGER_MAX_ITEMS = "-5";
    expect(getAutotriggerCap()).toBe(100);
    process.env.CASS_AUTOTRIGGER_MAX_ITEMS = "0";
    expect(getAutotriggerCap()).toBe(100);
  });
});

describe("isAwaitingManualStart", () => {
  it("returns true only when the flag is strictly true in the jsonb", () => {
    expect(isAwaitingManualStart({ awaiting_manual_start: true })).toBe(true);
    expect(
      isAwaitingManualStart({ awaiting_manual_start: true, reason: "cap" }),
    ).toBe(true);
  });

  it("returns false for null / missing / wrong-type values", () => {
    expect(isAwaitingManualStart(null)).toBe(false);
    expect(isAwaitingManualStart(undefined)).toBe(false);
    expect(isAwaitingManualStart({})).toBe(false);
    expect(isAwaitingManualStart({ awaiting_manual_start: "true" })).toBe(
      false,
    );
    expect(isAwaitingManualStart({ awaiting_manual_start: 1 })).toBe(false);
    expect(isAwaitingManualStart("string")).toBe(false);
  });
});
