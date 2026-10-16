import { describe, expect, it } from "vitest";

import { isMissingEngineColumnError, isMissingSwitchColumnError, readClassifierEngine, readNineRuleSwitch } from "./nine-questions-engine";

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
  it("a null, empty or unknown engine value is unreadable", async () => {
    for (const v of [null, "", "bogus"]) {
      expect(await readClassifierEngine(client({ data: { classifier_engine: v }, error: null }), "o")).toBe("unreadable");
    }
  });
  it("an empty result is unreadable, never outcome_v1 (the caller already found an active config)", async () => {
    expect(await readClassifierEngine(client({ data: null, error: null }), "o")).toBe("unreadable");
  });
});

describe("readNineRuleSwitch (PR 4, deploy-order safe)", () => {
  for (const column of ["nine_identity_reply", "nine_confirmed_owner_drip"] as const) {
    it(`${column}: missing column (app deployed before the migration) = column default true`, async () => {
      expect(await readNineRuleSwitch(client({ data: null, error: { code: "42703", message: "x" } }), "o", column)).toBe(true);
      const schemaCache = { code: "PGRST204", message: `Could not find the '${column}' column of 'ai_responder_configs' in the schema cache` };
      expect(isMissingSwitchColumnError(schemaCache, column)).toBe(true);
      expect(await readNineRuleSwitch(client({ data: null, error: schemaCache }), "o", column)).toBe(true);
      expect(await readNineRuleSwitch(client({ data: null, error: { message: `column ai_responder_configs.${column} does not exist` } }), "o", column)).toBe(true);
    });
    it(`${column}: any other read error, no row, or a non-boolean is OFF (fail closed)`, async () => {
      expect(await readNineRuleSwitch(client({ data: null, error: { code: "57014", message: "statement timeout" } }), "o", column)).toBe(false);
      expect(await readNineRuleSwitch(client({ data: null, error: { message: "fetch failed" } }), "o", column)).toBe(false);
      // A schema-cache message about some OTHER column is not proof this one is missing.
      expect(await readNineRuleSwitch(client({ data: null, error: { message: "Could not find the 'x' column in the schema cache" } }), "o", column)).toBe(false);
      expect(await readNineRuleSwitch(client({ data: null, error: null }), "o", column)).toBe(false);
      expect(await readNineRuleSwitch(client({ data: { [column]: null }, error: null }), "o", column)).toBe(false);
    });
    it(`${column}: reads the stored value`, async () => {
      expect(await readNineRuleSwitch(client({ data: { [column]: true }, error: null }), "o", column)).toBe(true);
      expect(await readNineRuleSwitch(client({ data: { [column]: false }, error: null }), "o", column)).toBe(false);
    });
  }
});
