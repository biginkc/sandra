import { describe, expect, it } from "vitest";

import { currentPipelineRun, runWithPipelineRun } from "./context";
import { runStatusForOutcome } from "./outcome";

describe("runStatusForOutcome", () => {
  it("maps every dispatch outcome to a run status", () => {
    expect(runStatusForOutcome({ outcome: "sent", messageId: "m", confidence: 1 })).toMatchObject({
      status: "replied",
      outboundMessageId: "m",
    });
    expect(runStatusForOutcome({ outcome: "escalated", reason: "keyword:hard" })).toMatchObject({
      status: "escalated",
      reason: "keyword:hard",
    });
    expect(
      runStatusForOutcome({ outcome: "escalated", reason: "jev_below_threshold:nurture" }).status,
    ).toBe("held");
    expect(runStatusForOutcome({ outcome: "auto_closed", reason: "r" }).status).toBe("closed");
    expect(runStatusForOutcome({ outcome: "opted_out", reason: "r" }).status).toBe("closed");
    expect(runStatusForOutcome({ outcome: "skipped", reason: "already_replied" })).toMatchObject({
      status: "skipped",
      reason: "already_replied",
    });
  });
});

describe("ambient run context", () => {
  it("is null outside a run and visible inside, across awaits", async () => {
    expect(currentPipelineRun()).toBeNull();
    const ctx = { runId: "r", orgId: "o", seq: 0 };
    const seen = await runWithPipelineRun(ctx, async () => {
      await Promise.resolve();
      return currentPipelineRun();
    });
    expect(seen).toBe(ctx);
    expect(currentPipelineRun()).toBeNull();
  });
});
