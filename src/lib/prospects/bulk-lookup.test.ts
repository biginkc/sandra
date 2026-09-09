import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";
import { partitionPropertyDncLocks } from "@/lib/dnc/property-lock";
import { resolveProspectEligibility } from "./eligibility";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createJob: vi.fn(),
  after: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/enrichment/cass-job", () => ({
  createStandaloneCassJob: mocks.createJob,
  failAuthorizedCassJobStart: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/cass-bulk", () => ({ cassBulkWorkflow: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { verifyPropertiesBulk } from "@/app/(dashboard)/properties/dnc-safe-actions";

const ids = Array.from({ length: 15_291 }, (_, i) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);
const locked = new Set([ids[0], ids[501], ids[15_289]]);
const disabled = new Set([ids[1], ids[502], ids[15_290]]);
const missing = ids[1000];

// Exercise the installed Supabase/PostgREST serializer, not a fluent-query mock.
// 32 KiB is the documented Cloudflare 414 limit, conservative relative to the
// observed unauthenticated HTTP/1.1 gateway boundary (~64 KiB).
function fixture(options: { failRequest?: number; wrongOrg?: boolean } = {}) {
  const requests: URL[] = [];
  const client = createClient<Database>("https://example.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        if (url.href.length > 32 * 1024) {
          return new Response("414 Request-URI Too Large", { status: 414 });
        }
        if (requests.length === options.failRequest) {
          return Response.json({ message: "lookup unavailable" }, { status: 400 });
        }
        const requested = url.searchParams.get("id")!.slice(4, -1).split(",");
        const rows = requested.filter((id) => id !== missing).map((id) => ({
          id,
          org_id: options.wrongOrg && id === ids[15_288] ? "other-org" : "org-1",
          status: locked.has(id) ? "interested" : "prospect",
          is_dnc_locked: locked.has(id),
          skip_trace_disabled: disabled.has(id),
        }));
        return Response.json(rows);
      },
    },
  });
  vi.spyOn(client.auth, "getUser").mockResolvedValue({
    data: { user: { id: "user-1" } }, error: null,
  } as Awaited<ReturnType<typeof client.auth.getUser>>);
  return { client, requests };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createJob.mockResolvedValue({ jobId: "job-1", claimToken: "claim-1" });
});

describe("large Prospects action lookups", () => {
  it.each(["cass", "skip_trace"] as const)(
    "resolves 15,291 IDs for %s and rechecks DNC without exceeding the URL cap",
    async (purpose) => {
      const { client, requests } = fixture();
      const result = await resolveProspectEligibility(client, [...ids, ids[0]], purpose);
      const expected = ids.filter((id) => id !== missing && !locked.has(id) &&
        (purpose !== "skip_trace" || !disabled.has(id)));
      expect(result.eligibleIds).toEqual(expected);
      expect(result.dncLockedCount).toBe(3);
      expect(result.skipTraceDisabledCount).toBe(purpose === "skip_trace" ? 3 : 0);
      expect(result.exclusions).toContainEqual({ propertyId: missing, reason: "not_found_or_not_prospect" });
      const partition = await partitionPropertyDncLocks(client, ids);
      expect(partition.ok, JSON.stringify(partition)).toBe(true);
      if (!partition.ok) return;
      expect(partition.data.locked).toEqual([...locked]);
      expect(partition.data.missing).toEqual([missing]);
      expect(partition.data.unlocked).toEqual(ids.filter((id) => id !== missing && !locked.has(id)));
      expect(requests.every((url) => url.href.length <= 32 * 1024)).toBe(true);
    },
  );

  it("creates a CASS job for the entire eligible selection after bounded ownership checks", async () => {
    const { client, requests } = fixture();
    mocks.createClient.mockResolvedValue(client);
    const result = await verifyPropertiesBulk(ids, "request-1");
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { jobId: "job-1" } });
    expect(mocks.createJob).toHaveBeenCalledWith(client, {
      orgId: "org-1", createdBy: "user-1", requestKey: "request-1",
      propertyIds: ids.filter((id) => id !== missing && !locked.has(id)),
    });
    expect(requests.every((url) => url.href.length <= 32 * 1024)).toBe(true);
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it("fails closed when a later DNC lookup fails", async () => {
    const { client } = fixture({ failRequest: 2 });
    const result = await partitionPropertyDncLocks(client, ids);
    expect(result).toMatchObject({ ok: false, error: {
      code: "PROPERTY_LOCK_CHECK_FAILED", message: "lookup unavailable",
    } });
  });

  it("rejects an organization mismatch in the last ownership batch before creating a job", async () => {
    const { client } = fixture({ wrongOrg: true });
    mocks.createClient.mockResolvedValue(client);
    const result = await verifyPropertiesBulk(ids, "request-1");
    expect(result).toMatchObject({ ok: false, error: { code: "VERIFY_SCOPE_FAILED", message: "Every selected property must belong to the same organization." } });
    expect(mocks.createJob).not.toHaveBeenCalled();
  });
});
