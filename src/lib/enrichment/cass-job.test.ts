import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

import {
  getAutotriggerCap,
  isAwaitingManualStart,
  selectCassEligibleProperties,
} from "./cass-job";

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

describe("selectCassEligibleProperties", () => {
  type JobItemRow = { property_id: string | null; status: string };
  type PropertyRow = { id: string; cass_status: string; is_dnc_locked?: boolean };

  type Capture = {
    jobItemsStatusFilter: string[] | null;
    propertiesIdFilter: string[] | null;
    propertiesCassStatusFilter: string | null;
    propertiesDncFilter: boolean | null;
  };

  function makeSupabase(
    jobItems: JobItemRow[],
    properties: PropertyRow[],
    capture: Capture,
  ): SupabaseClient<Database> {
    const fromMock = vi.fn((table: string) => {
      if (table === "job_items") {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          in: vi.fn((_col: string, values: string[]) => {
            capture.jobItemsStatusFilter = values;
            return builder;
          }),
          not: vi.fn(() => Promise.resolve({ data: jobItems, error: null })),
        };
        return builder;
      }
      if (table === "properties") {
        const builder = {
          select: vi.fn(() => builder),
          in: vi.fn((_col: string, values: string[]) => {
            capture.propertiesIdFilter = values;
            return builder;
          }),
          eq: vi.fn((col: string, value: string | boolean) => {
            if (col === "cass_status") {
              capture.propertiesCassStatusFilter = value as string;
              return builder;
            }
            capture.propertiesDncFilter = value as boolean;
            const matched = properties.filter(
              (p) =>
                (capture.propertiesIdFilter ?? []).includes(p.id) &&
                p.cass_status === capture.propertiesCassStatusFilter &&
                (p.is_dnc_locked ?? false) === value,
            );
            return Promise.resolve({
              data: matched.map((p) => ({ id: p.id })),
              error: null,
            });
          }),
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    });
    return { from: fromMock } as unknown as SupabaseClient<Database>;
  }

  function emptyCapture(): Capture {
    return {
      jobItemsStatusFilter: null,
      propertiesIdFilter: null,
      propertiesCassStatusFilter: null,
      propertiesDncFilter: null,
    };
  }

  it("includes newly-inserted properties (status='success', cass_status='unverified')", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase(
      [
        { property_id: "a", status: "success" },
        { property_id: "b", status: "success" },
      ],
      [
        { id: "a", cass_status: "unverified" },
        { id: "b", cass_status: "unverified" },
      ],
      capture,
    );
    const ids = await selectCassEligibleProperties(supabase, "job-1");
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("includes dedup-matched properties when their cass_status is still 'unverified' (recovery case)", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase(
      [
        { property_id: "x", status: "skipped" },
        { property_id: "y", status: "skipped" },
      ],
      [
        { id: "x", cass_status: "unverified" },
        { id: "y", cass_status: "unverified" },
      ],
      capture,
    );
    const ids = await selectCassEligibleProperties(supabase, "job-1");
    expect(ids.sort()).toEqual(["x", "y"]);
  });

  it("queries job_items with status IN ('success', 'skipped')", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase([], [], capture);
    await selectCassEligibleProperties(supabase, "job-1");
    expect(capture.jobItemsStatusFilter).toEqual(["success", "skipped"]);
  });

  it("filters out terminal CASS verdicts (verified/invalid/ambiguous) and 'error'", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase(
      [
        { property_id: "new1", status: "success" },
        { property_id: "dup-unv", status: "skipped" },
        { property_id: "dup-ver", status: "skipped" },
        { property_id: "dup-inv", status: "skipped" },
        { property_id: "dup-amb", status: "skipped" },
        { property_id: "dup-err", status: "skipped" },
      ],
      [
        { id: "new1", cass_status: "unverified" },
        { id: "dup-unv", cass_status: "unverified" },
        { id: "dup-ver", cass_status: "verified" },
        { id: "dup-inv", cass_status: "invalid" },
        { id: "dup-amb", cass_status: "ambiguous" },
        { id: "dup-err", cass_status: "error" },
      ],
      capture,
    );
    const ids = await selectCassEligibleProperties(supabase, "job-1");
    expect(ids.sort()).toEqual(["dup-unv", "new1"]);
    expect(capture.propertiesCassStatusFilter).toBe("unverified");
    expect(capture.propertiesDncFilter).toBe(false);
  });

  it("excludes permanent DNC before constructing a paid CASS job", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase(
      [
        { property_id: "safe", status: "success" },
        { property_id: "locked", status: "success" },
      ],
      [
        { id: "safe", cass_status: "unverified", is_dnc_locked: false },
        { id: "locked", cass_status: "unverified", is_dnc_locked: true },
      ],
      capture,
    );
    await expect(selectCassEligibleProperties(supabase, "job-1")).resolves.toEqual([
      "safe",
    ]);
  });

  it("returns [] when there are no eligible job_items (skips the properties query)", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase([], [], capture);
    const ids = await selectCassEligibleProperties(supabase, "job-1");
    expect(ids).toEqual([]);
    expect(capture.propertiesIdFilter).toBeNull();
  });

  it("ignores job_items rows with null property_id", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase(
      [
        { property_id: null, status: "success" },
        { property_id: "real", status: "success" },
      ],
      [{ id: "real", cass_status: "unverified" }],
      capture,
    );
    const ids = await selectCassEligibleProperties(supabase, "job-1");
    expect(ids).toEqual(["real"]);
    expect(capture.propertiesIdFilter).toEqual(["real"]);
  });

  it("returns [] when every dedup match is already in a terminal verdict (no waste)", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase(
      [
        { property_id: "v", status: "skipped" },
        { property_id: "i", status: "skipped" },
      ],
      [
        { id: "v", cass_status: "verified" },
        { id: "i", cass_status: "invalid" },
      ],
      capture,
    );
    const ids = await selectCassEligibleProperties(supabase, "job-1");
    expect(ids).toEqual([]);
  });
});
