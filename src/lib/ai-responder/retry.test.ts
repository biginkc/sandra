import { beforeEach, describe, expect, it, vi } from "vitest";

const { reportError, recordStep } = vi.hoisted(() => ({
  reportError: vi.fn(),
  recordStep: vi.fn(async () => undefined),
}));
vi.mock("@/lib/errors/report", () => ({ reportError }));
vi.mock("@/lib/pipeline-runs", () => ({ recordStep }));

import { writeReplyDeadLetter } from "./retry";

const args = {
  orgId: "org-1",
  conversationId: "conv-1",
  propertyId: "prop-1",
  inboundMessageId: "in-1",
  body: "SECRET REPLY TEXT",
  reason: "send_lease_lost",
};
const ctx = { runId: "run-1" } as never;

function client(results: Array<{ error: { message: string } | null } | Error>) {
  const insert = vi.fn(async () => {
    const next = results.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  return { insert, supabase: { from: vi.fn(() => ({ insert })) } as never };
}

describe("writeReplyDeadLetter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes one row and reports nothing on success", async () => {
    const { insert, supabase } = client([{ error: null }]);
    expect(await writeReplyDeadLetter(supabase, ctx, args)).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ body: "SECRET REPLY TEXT", run_id: "run-1", reason: "send_lease_lost" }));
    expect(reportError).not.toHaveBeenCalled();
  });

  it("retries the insert once and succeeds without any report", async () => {
    const { insert, supabase } = client([{ error: { message: "boom" } }, { error: null }]);
    expect(await writeReplyDeadLetter(supabase, ctx, args)).toBe(true);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("after the second failure records a dead_letter_failed step and a report with IDS ONLY (never the text)", async () => {
    const { insert, supabase } = client([{ error: { message: "boom" } }, new Error("boom again")]);
    expect(await writeReplyDeadLetter(supabase, ctx, args)).toBe(false);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(recordStep).toHaveBeenCalledWith(
      supabase,
      ctx,
      expect.objectContaining({
        name: "dead_letter_failed",
        result: "error",
        detail: { reason: "send_lease_lost", propertyId: "prop-1", inboundMessageId: "in-1" },
      }),
    );
    expect(JSON.stringify([reportError.mock.calls, recordStep.mock.calls])).not.toContain("SECRET REPLY TEXT");
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
