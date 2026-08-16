import { describe, expect, it, vi } from "vitest";

import { classifyPhonesWithDurableLedger } from "./csv-import";

function rpcClient(
  claimForPhone: (phone: string) => Record<string, unknown>,
) {
  const completions: Array<Record<string, unknown>> = [];
  const rpc = vi.fn(
    async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_csv_import_line_type_lookup") {
        return {
          data: [claimForPhone(String(args.p_phone_e164))],
          error: null,
        };
      }
      if (name === "complete_csv_import_line_type_lookup") {
        completions.push(args);
        return { data: null, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  );
  return { client: { rpc } as never, rpc, completions };
}

describe("classifyPhonesWithDurableLedger", () => {
  it("reuses completed classifications and calls Telnyx only for a new claim", async () => {
    const { client, completions } = rpcClient((phone) =>
      phone.endsWith("001")
        ? { action: "reused", line_type: "mobile", outcome: "classified" }
        : { action: "claimed", line_type: null, outcome: null },
    );
    const lookup = {
      classifyOne: vi.fn().mockResolvedValue({
        status: "completed",
        lineType: "landline",
        reason: "classified",
        httpStatus: 200,
      }),
    };

    const result = await classifyPhonesWithDurableLedger(client, lookup, {
      jobId: "job-1",
      orgId: "org-1",
      numbers: ["+18165550001", "+18165550002"],
    });

    expect(result).toEqual([
      ["+18165550001", "mobile"],
      ["+18165550002", "landline"],
    ]);
    expect(lookup.classifyOne).toHaveBeenCalledTimes(1);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      p_phone_e164: "+18165550002",
      p_state: "completed",
      p_line_type: "landline",
      p_outcome: "classified",
    });
  });

  it("does not cross the paid boundary for an ambiguous or same-retry claim", async () => {
    const { client } = rpcClient((phone) => ({
      action: phone.endsWith("001") ? "ambiguous" : "retry_blocked",
      line_type: "unknown",
      outcome: "transport_unknown",
    }));
    const lookup = { classifyOne: vi.fn() };

    await expect(
      classifyPhonesWithDurableLedger(client, lookup, {
        jobId: "job-1",
        orgId: "org-1",
        numbers: ["+18165550001", "+18165550002"],
      }),
    ).rejects.toThrow("2 safely checkpointed provider outcome");
    expect(lookup.classifyOne).not.toHaveBeenCalled();
  });

  it("checkpoints an explicit provider rejection before surfacing retry", async () => {
    const { client, completions } = rpcClient(() => ({
      action: "claimed",
      line_type: null,
      outcome: null,
    }));
    const lookup = {
      classifyOne: vi.fn().mockResolvedValue({
        status: "retryable",
        lineType: "unknown",
        reason: "provider_rejected",
        httpStatus: 503,
      }),
    };

    await expect(
      classifyPhonesWithDurableLedger(client, lookup, {
        jobId: "job-1",
        orgId: "org-1",
        numbers: ["+18165550001"],
      }),
    ).rejects.toThrow("1 safely checkpointed provider outcome");
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      p_state: "retryable",
      p_outcome: "provider_rejected",
      p_provider_http_status: 503,
    });
  });

  it.each([402, 408, 409])(
    "does not return a deletable unknown classification for HTTP %i",
    async (httpStatus) => {
      const { client, completions } = rpcClient(() => ({
        action: "claimed",
        line_type: null,
        outcome: null,
      }));
      const lookup = {
        classifyOne: vi.fn().mockResolvedValue({
          status: "retryable",
          lineType: "unknown",
          reason: "provider_rejected",
          httpStatus,
        }),
      };

      await expect(
        classifyPhonesWithDurableLedger(client, lookup, {
          jobId: "job-1",
          orgId: "org-1",
          numbers: ["+18165550001"],
        }),
      ).rejects.toThrow("1 safely checkpointed provider outcome");
      expect(completions).toEqual([
        expect.objectContaining({
          p_state: "retryable",
          p_line_type: "unknown",
          p_outcome: "provider_rejected",
          p_provider_http_status: httpStatus,
        }),
      ]);
    },
  );
});
