import { describe, expect, it, vi } from "vitest";

import { runPromoteLeadsChunk } from "./promote-job";

describe("runPromoteLeadsChunk", () => {
  it("processes each durable item by job id + item key", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { outcome: "promoted" }, error: null });
    const outcomes = await runPromoteLeadsChunk({ rpc } as never, {
      jobId: "job-1",
      itemKeys: ["property-a", "property-b"],
    });

    expect(outcomes).toEqual([
      { itemKey: "property-a", outcome: "promoted" },
      { itemKey: "property-b", outcome: "promoted" },
    ]);
    expect(rpc).toHaveBeenNthCalledWith(1, "process_promote_leads_item", {
      p_job: "job-1",
      p_item_key: "property-a",
    });
  });

  it("checkpoints an item failure and continues the background chunk", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: "synthetic row failure" } })
      .mockResolvedValueOnce({ data: { failed: 1 }, error: null })
      .mockResolvedValueOnce({ data: { outcome: "already_lead" }, error: null });

    const outcomes = await runPromoteLeadsChunk({ rpc } as never, {
      jobId: "job-2",
      itemKeys: ["property-a", "property-b"],
    });

    expect(outcomes).toEqual([
      { itemKey: "property-a", outcome: "failed" },
      { itemKey: "property-b", outcome: "already_lead" },
    ]);
    expect(rpc).toHaveBeenNthCalledWith(2, "fail_promote_leads_item", {
      p_job: "job-2",
      p_item_key: "property-a",
      p_error: "synthetic row failure",
    });
  });

  it("throws when the durable failure checkpoint itself cannot be written", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: "process failed" } })
      .mockResolvedValueOnce({ data: null, error: { message: "checkpoint failed" } });

    await expect(
      runPromoteLeadsChunk({ rpc } as never, {
        jobId: "job-3",
        itemKeys: ["property-a"],
      }),
    ).rejects.toThrow(/checkpoint failed/i);
  });
});
