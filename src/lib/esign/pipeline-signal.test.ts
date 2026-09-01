import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import {
  createPipelineSignalLoader,
  LATEST_ESIGN_REQUESTS_RPC,
  loadPipelineSignals,
  MAX_PIPELINE_SIGNAL_PROPERTIES,
  type LatestEsignRequestRpcRow,
  type PipelineSignalLoader,
  type PipelineSignalRow,
} from "./pipeline-signal";

const row = (
  propertyId: string,
  id: string,
  createdAt: string,
  status: PipelineSignalRow["status"] = "awaiting",
): PipelineSignalRow => ({
  org_id: "org-1",
  property_id: propertyId,
  id,
  created_at: createdAt,
  status,
});

describe("loadPipelineSignals", () => {
  it("locks the reviewed RPC name and corrected return DTO", () => {
    const rpcRow = {
      org_id: "org-1",
      property_id: "property-1",
      id: "request-1",
      created_at: "2026-08-29T12:00:00.000Z",
      status: "voided",
    } satisfies LatestEsignRequestRpcRow;

    expect(LATEST_ESIGN_REQUESTS_RPC).toBe(
      "get_latest_esign_requests_for_properties",
    );
    expect(Object.keys(rpcRow).sort()).toEqual([
      "created_at",
      "id",
      "org_id",
      "property_id",
      "status",
    ]);
  });

  it("binds the generated RPC contract to the trusted organization scope", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        row(
          "property-1",
          "request-1",
          "2026-08-29T12:00:00.000Z",
          "signed",
        ),
      ],
      error: null,
    });
    const loader = createPipelineSignalLoader({ rpc } as unknown as SupabaseClient<Database>);

    await expect(
      loader({ orgId: "org-1", propertyIds: ["property-1"] }),
    ).resolves.toEqual([
      row(
        "property-1",
        "request-1",
        "2026-08-29T12:00:00.000Z",
        "signed",
      ),
    ]);
    expect(rpc).toHaveBeenCalledWith(LATEST_ESIGN_REQUESTS_RPC, {
      p_org_id: "org-1",
      p_property_ids: ["property-1"],
    });
  });

  it("does not call the loader for an empty card set", async () => {
    const loader = vi.fn<PipelineSignalLoader>();

    const result = await loadPipelineSignals(loader, {
      orgId: "org-1",
      propertyIds: [],
    });

    expect(result.size).toBe(0);
    expect(loader).not.toHaveBeenCalled();
  });

  it("deduplicates property ids and preserves explicit org scope", async () => {
    const loader = vi.fn<PipelineSignalLoader>().mockResolvedValue([]);

    await loadPipelineSignals(loader, {
      orgId: "org-1",
      propertyIds: ["property-1", "property-1", "property-2"],
    });

    expect(loader).toHaveBeenCalledWith({
      orgId: "org-1",
      propertyIds: ["property-1", "property-2"],
    });
  });

  it("rejects an unbounded card request before loading", async () => {
    const loader = vi.fn<PipelineSignalLoader>();
    const propertyIds = Array.from(
      { length: MAX_PIPELINE_SIGNAL_PROPERTIES + 1 },
      (_, index) => `property-${index}`,
    );

    await expect(
      loadPipelineSignals(loader, { orgId: "org-1", propertyIds }),
    ).rejects.toThrow(/limited to 50 properties/i);
    expect(loader).not.toHaveBeenCalled();
  });

  it("returns latest signals only for requested properties", async () => {
    const older = row(
      "property-1",
      "00000000-0000-0000-0000-000000000101",
      "2026-08-29T12:00:00.000Z",
    );
    const newer = row(
      "property-1",
      "00000000-0000-0000-0000-000000000102",
      "2026-08-29T12:01:00.000Z",
      "viewed",
    );
    const loader = vi.fn<PipelineSignalLoader>().mockResolvedValue([
      older,
      newer,
      row("property-outside-request", "request-3", "2026-08-29T12:02:00.000Z"),
    ]);

    const result = await loadPipelineSignals(loader, {
      orgId: "org-1",
      propertyIds: ["property-1", "property-without-contract"],
    });

    expect([...result.entries()]).toEqual([["property-1", newer]]);
    expect(result.has("property-without-contract")).toBe(false);
    expect(result.has("property-outside-request")).toBe(false);
  });

  it("drops a same-property row from another organization", async () => {
    const ownRow = row(
      "property-1",
      "request-own",
      "2026-08-29T12:00:00.000Z",
    );
    const foreignRow = {
      ...row(
        "property-1",
        "request-foreign",
        "2026-08-29T12:01:00.000Z",
        "signed",
      ),
      org_id: "org-2",
    };
    const loader = vi
      .fn<PipelineSignalLoader>()
      .mockResolvedValue([foreignRow, ownRow]);

    const result = await loadPipelineSignals(loader, {
      orgId: "org-1",
      propertyIds: ["property-1"],
    });

    expect(result.get("property-1")).toBe(ownRow);
  });

  it("fails soft when the loader returns malformed runtime data", async () => {
    const malformed = {
      ...row("property-1", "request-1", "not-a-timestamp"),
      status: "provider-only-status",
    } as unknown as PipelineSignalRow;
    const loader = vi
      .fn<PipelineSignalLoader>()
      .mockResolvedValue([malformed]);

    const result = await loadPipelineSignals(loader, {
      orgId: "org-1",
      propertyIds: ["property-1"],
    });

    expect(result.size).toBe(0);
  });

  it("fails soft when optional card decoration loading fails", async () => {
    const loader = vi
      .fn<PipelineSignalLoader>()
      .mockRejectedValue(new Error("database unavailable"));

    const result = await loadPipelineSignals(loader, {
      orgId: "org-1",
      propertyIds: ["property-1"],
    });

    expect(result.size).toBe(0);
  });
});
