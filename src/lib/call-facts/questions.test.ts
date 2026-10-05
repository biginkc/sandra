import { describe, expect, it } from "vitest";

import { FACT_FIELDS, FACT_LABELS } from "./catalog";
import { activeQuestions, FACT_QUESTIONS } from "./questions";

describe("question registry", () => {
  it("has one slot per approved question: 5 numbers/dates + 14 pains + motivation + not_rushed + bad_experience + 29 objections", () => {
    expect(FACT_QUESTIONS).toHaveLength(5 + 14 + 3 + 29);
    expect(activeQuestions()).toHaveLength(FACT_QUESTIONS.length); // every question is approved, none null
    expect(new Set(FACT_QUESTIONS.map((q) => q.field)).size).toBe(FACT_QUESTIONS.length);
  });
  it("keeps condition as the last (lowest priority) field, with no question", () => {
    expect(FACT_FIELDS.at(-1)).toBe("condition");
    expect(FACT_QUESTIONS.some((q) => q.field === "condition")).toBe(false);
    expect(FACT_LABELS.pain_divorce).toBe("Divorce");
    expect(FACT_LABELS.objection_think).toBe("Decision time");
  });
  it("skips blank text", () => {
    expect(activeQuestions([{ id: "x", field: "x", label: "X", kind: "turn", text: "  " }])).toEqual([]);
  });
});
