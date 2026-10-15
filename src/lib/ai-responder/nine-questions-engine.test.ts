import { describe, expect, it } from "vitest";

import { isMissingEngineColumnError, readClassifierEngine } from "./nine-questions-engine";

const client = (result: { data: unknown; error: unknown }) =>
  ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }) }) }) as never;

describe("readClassifierEngine", () => {
  it("missing column (pre-migration) reads as outcome_v1", async () => {
    expect(isMissingEngineColumnError({ code: "42703", message: "x" })).toBe(true);
    expect(isMissingEngineColumnError({ message: "column ai_responder_configs.classifier_engine does not exist" })).toBe(true);
    expect(await readClassifierEngine(client({ data: null, error: { code: "42703", message: "x" } }), "o")).toBe("outcome_v1");
  });
  it("any other read error is unreadable (fail closed)", async () => {
    expect(await readClassifierEngine(client({ data: null, error: { code: "57014", message: "statement timeout" } }), "o")).toBe("unreadable");
    expect(await readClassifierEngine(client({ data: null, error: { message: "fetch failed" } }), "o")).toBe("unreadable");
  });
  it("reads the stored values", async () => {
    expect(await readClassifierEngine(client({ data: { classifier_engine: "nine_questions" }, error: null }), "o")).toBe("nine_questions");
    expect(await readClassifierEngine(client({ data: { classifier_engine: "outcome_v1" }, error: null }), "o")).toBe("outcome_v1");
  });
  it("an empty result is unreadable, never outcome_v1 (the caller already found an active config)", async () => {
    expect(await readClassifierEngine(client({ data: null, error: null }), "o")).toBe("unreadable");
  });
});
