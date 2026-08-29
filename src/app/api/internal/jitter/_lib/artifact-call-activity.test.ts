import { describe, expect, it } from "vitest";

import { classifyArtifactIdentity } from "./artifact-call-activity";

describe("classifyArtifactIdentity", () => {
  const callId = "c5226422-91d8-468b-82c6-7c0cf198a46c";

  it("accepts the production-shaped softphone attempt and scope pair", () => {
    expect(classifyArtifactIdentity(
      `sandra-${callId}`,
      `sandra-softphone-session-${callId}:run_1`,
    )).toEqual({ kind: "softphone", callId });
  });

  it.each([
    [`sandra-${callId}`, `sandra-softphone-session-other:run_1`],
    [`sandra-${callId}`, `sandra-softphone-session-${callId}:`],
    [`sandra-${callId}`, "ordinary-scope"],
    ["attempt-1", `sandra-softphone-session-${callId}:run_1`],
  ])("rejects incoherent softphone identity %#", (attemptId, scopeId) => {
    expect(classifyArtifactIdentity(attemptId, scopeId)).toBeNull();
  });

  it("keeps ordinary Jitter identity on the exact-session path", () => {
    expect(classifyArtifactIdentity("attempt-1", "scope-1")).toEqual({ kind: "jitter" });
  });
});
