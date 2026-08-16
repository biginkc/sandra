import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

import {
  createCassChildJob,
  createStandaloneCassJob,
  getAutotriggerCap,
  isAwaitingManualStart,
  selectCassEligibleProperties,
} from "./cass-job";

describe("CASS authorization RPC adapters", () => {
  it("marks a child retry with its source job instead of fabricating a row", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          job_id: "child-job",
          claim_token: "child-claim",
          created: true,
          job_status: "running",
        },
      ],
      error: null,
    });
    const supabase = { rpc } as unknown as SupabaseClient<Database>;

    await expect(
      createCassChildJob(supabase, {
        parentJobId: "import-job",
        relatedImportId: "import-id",
        createdBy: "user-id",
        orgId: "org-id",
        propertyIds: ["property-id"],
        autoStart: true,
        sourceJobId: "failed-cass-job",
        requestKey: "failed-cass-job",
      }),
    ).resolves.toEqual({
      jobId: "child-job",
      claimToken: "child-claim",
      created: true,
      status: "running",
    });

    expect(rpc).toHaveBeenCalledWith("create_authorized_cass_job", {
      p_org_id: "org-id",
      p_property_ids: ["property-id"],
      p_purpose: "retry",
      p_parent_job_id: "import-job",
      p_related_import_id: "import-id",
      p_source_job_id: "failed-cass-job",
      p_created_by: "user-id",
      p_auto_start: true,
      p_blocked_reason: null,
      p_request_key: "failed-cass-job",
    });
  });

  it("atomically creates and claims standalone work with a stable request key", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          job_id: "standalone-job",
          claim_token: "claim-token",
          created: true,
          job_status: "running",
        },
      ],
      error: null,
    });
    const supabase = { rpc } as unknown as SupabaseClient<Database>;

    const result = await createStandaloneCassJob(supabase, {
      orgId: "org-id",
      propertyIds: ["property-id"],
      createdBy: "user-id",
      requestKey: "request-id",
    });
    expect(result).toEqual({
      jobId: "standalone-job",
      claimToken: "claim-token",
      created: true,
      status: "running",
    });
    expect(rpc).toHaveBeenCalledWith("create_authorized_cass_job", {
      p_org_id: "org-id",
      p_property_ids: ["property-id"],
      p_purpose: "standalone",
      p_parent_job_id: null,
      p_related_import_id: null,
      p_source_job_id: null,
      p_created_by: "user-id",
      p_auto_start: true,
      p_blocked_reason: null,
      p_request_key: "request-id",
    });
  });
});

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
  type JobItemRow = { id?: string; property_id: string | null; status: string };
  type PropertyRow = {
    id: string;
    org_id?: string;
    cass_status: string;
    is_dnc_locked?: boolean;
  };

  type Capture = {
    jobItemsStatusFilter: string[] | null;
    propertiesIdFilter: string[] | null;
    propertiesOrgFilter: string | null;
    propertiesCassStatusFilter: string | null;
    propertiesDncFilter: boolean | null;
  };

  function makeSupabase(
    jobItems: JobItemRow[],
    properties: PropertyRow[],
    capture: Capture,
    childJobs: { id: string }[] = [],
    ambiguousItems: { property_id: string | null }[] = [],
  ): SupabaseClient<Database> {
    let jobItemsQuery = 0;
    const fromMock = vi.fn((table: string) => {
      if (table === "job_items") {
        jobItemsQuery++;
        if (jobItemsQuery > 1) {
          const builder = {
            select: vi.fn(() => builder),
            in: vi.fn(() => builder),
            eq: vi.fn(() => builder),
            order: vi.fn(() => builder),
            gt: vi.fn(() => builder),
            limit: vi.fn(() =>
              Promise.resolve({
                data: ambiguousItems.map((item, index) => ({
                  id: `ambiguous-${index}`,
                  ...item,
                })),
                error: null,
              }),
            ),
          };
          return builder;
        }
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          in: vi.fn((_col: string, values: string[]) => {
            capture.jobItemsStatusFilter = values;
            return builder;
          }),
          not: vi.fn(() => builder),
          order: vi.fn(() => builder),
          gt: vi.fn(() => builder),
          limit: vi.fn(() =>
            Promise.resolve({
              data: jobItems.map((item, index) => ({
                id: item.id ?? `item-${index}`,
                ...item,
              })),
              error: null,
            }),
          ),
        };
        return builder;
      }
      if (table === "jobs") {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          order: vi.fn(() => builder),
          gt: vi.fn(() => builder),
          limit: vi.fn(() => Promise.resolve({ data: childJobs, error: null })),
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
            if (col === "org_id") {
              capture.propertiesOrgFilter = value as string;
              return builder;
            }
            if (col === "cass_status") {
              capture.propertiesCassStatusFilter = value as string;
              return builder;
            }
            capture.propertiesDncFilter = value as boolean;
            const matched = properties.filter(
              (p) =>
                (capture.propertiesIdFilter ?? []).includes(p.id) &&
                (p.org_id ?? "org-1") === capture.propertiesOrgFilter &&
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
      propertiesOrgFilter: null,
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
    const ids = await selectCassEligibleProperties(supabase, "job-1", "org-1");
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
    const ids = await selectCassEligibleProperties(supabase, "job-1", "org-1");
    expect(ids.sort()).toEqual(["x", "y"]);
  });

  it("queries job_items with status IN ('success', 'skipped')", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase([], [], capture);
    await selectCassEligibleProperties(supabase, "job-1", "org-1");
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
    const ids = await selectCassEligibleProperties(supabase, "job-1", "org-1");
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
    await expect(selectCassEligibleProperties(supabase, "job-1", "org-1")).resolves.toEqual([
      "safe",
    ]);
  });

  it("excludes a job item whose property belongs to another organization", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase(
      [
        { property_id: "owned", status: "success" },
        { property_id: "foreign", status: "success" },
      ],
      [
        { id: "owned", org_id: "org-1", cass_status: "unverified" },
        { id: "foreign", org_id: "org-2", cass_status: "unverified" },
      ],
      capture,
    );

    await expect(
      selectCassEligibleProperties(supabase, "job-1", "org-1"),
    ).resolves.toEqual(["owned"]);
    expect(capture.propertiesOrgFilter).toBe("org-1");
  });

  it("returns [] when there are no eligible job_items (skips the properties query)", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase([], [], capture);
    const ids = await selectCassEligibleProperties(supabase, "job-1", "org-1");
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
    const ids = await selectCassEligibleProperties(supabase, "job-1", "org-1");
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
    const ids = await selectCassEligibleProperties(supabase, "job-1", "org-1");
    expect(ids).toEqual([]);
  });

  it("does not re-spend an import retry on a terminal ambiguous child result", async () => {
    const capture = emptyCapture();
    const supabase = makeSupabase(
      [{ property_id: "ambiguous-paid", status: "success" }],
      [{ id: "ambiguous-paid", cass_status: "unverified" }],
      capture,
      [{ id: "cass-child" }],
      [{ property_id: "ambiguous-paid" }],
    );

    await expect(
      selectCassEligibleProperties(supabase, "job-1", "org-1"),
    ).resolves.toEqual([]);
  });

  it("conserves 1,001 candidate rows across keyset pages and bounded property chunks", async () => {
    const items = Array.from({ length: 1_001 }, (_, index) => ({
      id: `item-${String(index).padStart(4, "0")}`,
      property_id: `property-${index}`,
    }));
    const propertyChunkSizes: number[] = [];
    const from = vi.fn((table: string) => {
      if (table === "job_items") {
        let cursor: string | null = null;
        const builder: Record<string, unknown> = {};
        for (const method of ["select", "eq", "in", "not", "order", "limit"]) {
          builder[method] = vi.fn(() => builder);
        }
        builder.gt = vi.fn((_column: string, value: string) => {
          cursor = value;
          return builder;
        });
        builder.then = (
          resolve: (value: { data: typeof items; error: null }) => unknown,
        ) => {
          const page = items
            .filter((item) => cursor === null || item.id > cursor)
            .slice(0, 500);
          return Promise.resolve(resolve({ data: page, error: null }));
        };
        return builder;
      }
      if (table === "properties") {
        let ids: string[] = [];
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.in = (_column: string, values: string[]) => {
          ids = values;
          propertyChunkSizes.push(values.length);
          return builder;
        };
        let eqCalls = 0;
        builder.eq = () => {
          eqCalls++;
          return eqCalls === 3
            ? Promise.resolve({
                data: ids.map((id) => ({ id })),
                error: null,
              })
            : builder;
        };
        return builder;
      }
      if (table === "jobs") {
        const builder: Record<string, unknown> = {};
        for (const method of ["select", "eq", "order", "limit", "gt"]) {
          builder[method] = vi.fn(() => builder);
        }
        builder.then = (
          resolve: (value: { data: never[]; error: null }) => unknown,
        ) => Promise.resolve(resolve({ data: [], error: null }));
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    });

    const ids = await selectCassEligibleProperties(
      { from } as unknown as SupabaseClient<Database>,
      "job-scale",
      "org-1",
    );

    expect(ids).toHaveLength(1_001);
    expect(new Set(ids)).toEqual(
      new Set(items.map((item) => item.property_id)),
    );
    expect(propertyChunkSizes).toEqual([500, 500, 1]);
  });
});
