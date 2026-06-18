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
      .eq("id", result.data.jobId!)
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
    expect(result.data.eligible).toBe(1);
    expect(result.data.cassSkipped).toBe(2);

    const { data: job } = await testClient
      .from("jobs")
      .select("input_params, title")
      .eq("id", result.data.jobId!)
      .single();
    const input = (job!.input_params as { property_ids: string[] }).property_ids;
    expect(input).toEqual([verified]);
    expect(job!.title).toMatch(/2 need.* CASS/i);
  });

  it("reports none_eligible (not an error) when every property needs CASS", async () => {
    const ids = await Promise.all([
      seedProperty({ address: "1 Block Ln", cassStatus: "unverified" }),
      seedProperty({ address: "2 Block Ln", cassStatus: "unverified" }),
    ]);

    const result = await requestSkipTrace(ids);
    // A normal "verify the addresses first" state, surfaced as a success
    // outcome so the UI renders info — never a red failure toast.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("none_eligible");
    expect(result.data.jobId).toBeNull();
    expect(result.data.eligible).toBe(0);
    expect(result.data.cassSkipped).toBe(2);
    expect(result.data.killSwitchSkipped).toBe(0);
  });

  it("regression: reports none_eligible when every property is kill-switched and none need CASS", async () => {
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("none_eligible");
    expect(result.data.killSwitchSkipped).toBe(2);
    expect(result.data.cassSkipped).toBe(0);
  });

  it("reports none_eligible with both counts when both gates trip together", async () => {
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("none_eligible");
    expect(result.data.eligible).toBe(0);
    expect(result.data.killSwitchSkipped).toBe(1);
    expect(result.data.cassSkipped).toBe(1);
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
    expect(result.data.eligible).toBe(1);
    expect(result.data.cassSkipped).toBe(1);
    expect(result.data.killSwitchSkipped).toBe(1);

    const { data: job } = await testClient
      .from("jobs")
      .select("title, input_params")
      .eq("id", result.data.jobId!)
      .single();
    expect(job!.title).toMatch(/1 kill-switched/);
    expect(job!.title).toMatch(/1 need.* CASS/i);
    const input = (job!.input_params as { property_ids: string[] }).property_ids;
    expect(input).toEqual([verified]);
  });
});
