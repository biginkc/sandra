import { describe, expect, it } from "vitest";

import { buildQuestions, OUTCOME_CRITERIA } from "../questions";
import {
  LUNA_ESCALATION_REASONS,
  LUNA_FRAMING,
  LUNA_OUTCOMES,
  lunaJsonSchema,
  lunaSystemPrompt,
  lunaUserPrompt,
} from "./prompt";

describe("Luna prompt governance", () => {
  const prompt = lunaSystemPrompt();
  const Q = buildQuestions(false);

  it("carries Jev's outcome definitions and instructions verbatim", () => {
    expect(prompt).toContain(Q.outcome.instructions);
    expect(prompt).toContain(Q.escalation_reason.instructions);
    for (const [name, def] of Object.entries(OUTCOME_CRITERIA)) {
      expect(prompt).toContain(`${name}: ${def}`);
    }
    for (const [name, def] of Object.entries(Q.escalation_reason.criteria)) {
      expect(prompt).toContain(`${name}: ${def}`);
    }
  });

  it("holds exactly the six pending framing sentences in one constant", () => {
    expect(Object.keys(LUNA_FRAMING)).toEqual(["role", "task", "outcomeHeader", "escalationHeader", "format", "userHeader"]);
    for (const key of ["role", "task", "outcomeHeader", "escalationHeader", "format"] as const) {
      expect(prompt).toContain(LUNA_FRAMING[key]);
    }
    expect(lunaUserPrompt([])).toContain(LUNA_FRAMING.userHeader);
  });

  it("contains nothing beyond the framing and Jev text (every paragraph is accounted for)", () => {
    const allowed = new Set<string>([
      ...Object.values(LUNA_FRAMING),
      Q.outcome.instructions,
      Q.escalation_reason.instructions,
      ...Object.entries(OUTCOME_CRITERIA).map(([n, d]) => `${n}: ${d}`),
      ...Object.entries(Q.escalation_reason.criteria).map(([n, d]) => `${n}: ${d}`),
    ]);
    for (const paragraph of prompt.split("\n\n")) expect(allowed.has(paragraph)).toBe(true);
  });

  it("labels the thread without adding rules", () => {
    expect(lunaUserPrompt([{ direction: "outbound", body: "Hi" }, { direction: "inbound", body: "Who?" }])).toBe(
      `${LUNA_FRAMING.userHeader}\n[outbound] Hi\n[inbound] Who?`,
    );
  });

  it("derives schema enums from the Jev code", () => {
    const schema = lunaJsonSchema();
    expect(schema.properties.outcome.enum).toEqual(LUNA_OUTCOMES);
    expect(schema.properties.escalation_reason.enum).toEqual(LUNA_ESCALATION_REASONS);
    expect(schema.additionalProperties).toBe(false);
  });
});
