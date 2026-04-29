import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

// `after()` requires a request scope — stub it to a no-op so the
// action returns synchronously. We assert against the inserted job
// row, not the runner side-effects.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>(
    "next/server",
  );
  return { ...actual, after: (_fn: () => unknown) => {} };
});

vi.mock("@/lib/skip-trace/skip-trace-job", () => ({
  runSkipTraceEnrichment: vi.fn(async () => {}),
}));

process.env.ADMIN_EMAILS = "jarrad@bmhgroupkc.com";

let currentEmail: string | null = "jarrad@bmhgroupkc.com";
let currentUserId: string | null = null;
vi.spyOn(testClient.auth, "getUser").mockImplementation(async () =>
  ({
    data: {
      user: currentEmail
        ? ({ id: currentUserId, email: currentEmail } as never)
        : null,
    },
    error: null,
  }) as never,
);

// eslint-disable-next-line import/first
import { requestSkipTrace } from "./actions";

async function seedProperty(opts: {
  address: string;
  cassStatus?: "verified" | "unverified" | "invalid" | "ambiguous";
  killSwitch?: boolean;
}): Promise<string> {
  const insert: Record<string, unknown> = {
    address: opts.address,
    state: "MO",
    status: "prospect",
    skip_trace_disabled: opts.killSwitch ?? false,
  };
  if (opts.cassStatus) insert.cass_status = opts.cassStatus;
  const { data, error } = await testClient
    .from("properties")
    .insert(insert as never)
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed property failed");
  return data.id;
}

describe("requestSkipTrace pre-flight gates (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    currentEmail = "jarrad@bmhgroupkc.com";
    currentUserId = null;
  });

  it("happy path: all CASS-verified, no kill-switch — every id lands in input_params", async () => {
    const ids = await Promise.all([
      seedProperty({ address: "1 Verified Ln", cassStatus: "verified" }),
      seedProperty({ address: "2 Verified Ln", cassStatus: "verified" }),
    ]);

    const result = await requestSkipTrace(ids);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: job } = await testClient
      .from("jobs")
      .select("input_params, title")
      .eq("id", result.data.jobId)
      .single();
    const input = (job!.input_params as { property_ids: string[] }).property_ids;
    expect(new Set(input)).toEqual(new Set(ids));
    // No skipped suffix on the happy path.
    expect(job!.title).not.toMatch(/skipped/i);
  });

  it("filters out CASS-unverified properties before sending to vendor", async () => {
    const verified = await seedProperty({
      address: "1 Pass Ln",
      cassStatus: "verified",
    });
    const unverified = await seedProperty({
      address: "2 Block Ln",
      cassStatus: "unverified",
    });
    const nullStatus = await seedProperty({ address: "3 Null Ln" });

    const result = await requestSkipTrace([verified, unverified, nullStatus]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: job } = await testClient
      .from("jobs")
      .select("input_params, title")
      .eq("id", result.data.jobId)
      .single();
    const input = (job!.input_params as { property_ids: string[] }).property_ids;
    expect(input).toEqual([verified]);
    expect(job!.title).toMatch(/2 need.* CASS/i);
  });

  it("refuses with ALL_PROPERTIES_NEED_CASS when every property is unverified", async () => {
    const ids = await Promise.all([
      seedProperty({ address: "1 Block Ln", cassStatus: "unverified" }),
      seedProperty({ address: "2 Block Ln", cassStatus: "unverified" }),
    ]);

    const result = await requestSkipTrace(ids);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ALL_PROPERTIES_NEED_CASS");
    expect(result.error.message).toMatch(/CASS|verification/i);
  });

  it("regression: refuses with ALL_PROPERTIES_DISABLED when every property is kill-switched and none need CASS", async () => {
    const ids = await Promise.all([
      seedProperty({
        address: "1 Off Ln",
        cassStatus: "verified",
        killSwitch: true,
      }),
      seedProperty({
        address: "2 Off Ln",
        cassStatus: "verified",
        killSwitch: true,
      }),
    ]);

    const result = await requestSkipTrace(ids);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ALL_PROPERTIES_DISABLED");
  });

  it("returns NO_ELIGIBLE_PROPERTIES when both gates trip together", async () => {
    const killed = await seedProperty({
      address: "1 Off Ln",
      cassStatus: "verified",
      killSwitch: true,
    });
    const unverified = await seedProperty({
      address: "2 Block Ln",
      cassStatus: "unverified",
    });

    const result = await requestSkipTrace([killed, unverified]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NO_ELIGIBLE_PROPERTIES");
    expect(result.error.message).toMatch(/disabled/);
    expect(result.error.message).toMatch(/CASS/i);
  });

  it("includes both skipped counts in the title when they apply together", async () => {
    const verified = await seedProperty({
      address: "1 Pass Ln",
      cassStatus: "verified",
    });
    const killed = await seedProperty({
      address: "2 Off Ln",
      cassStatus: "verified",
      killSwitch: true,
    });
    const unverified = await seedProperty({
      address: "3 Block Ln",
      cassStatus: "unverified",
    });

    const result = await requestSkipTrace([verified, killed, unverified]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: job } = await testClient
      .from("jobs")
      .select("title, input_params")
      .eq("id", result.data.jobId)
      .single();
    expect(job!.title).toMatch(/1 kill-switched/);
    expect(job!.title).toMatch(/1 need.* CASS/i);
    const input = (job!.input_params as { property_ids: string[] }).property_ids;
    expect(input).toEqual([verified]);
  });
});
