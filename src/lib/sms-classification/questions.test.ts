import { describe, expect, it } from "vitest";

import {
  buildQuestions,
  JEV_SCHEMA_VERSION,
  NUMBER_SOURCE_QUESTION_ID,
} from "./questions";

describe("asked_how_number_obtained question", () => {
  // Human-approved text (Jarrad, 2026-10-07). A change here needs a new approval,
  // not a test edit.
  it("is pinned to the exact approved text", () => {
    expect(NUMBER_SOURCE_QUESTION_ID).toBe("asked_how_number_obtained");
    expect(buildQuestions(false).asked_how_number_obtained).toEqual({
      type: "choice",
      instructions: "Did the seller ask anything about how we obtained the phone number?",
      criteria: {
        yes: "The seller asks how, where or from whom we got their number.",
        no: "The seller does not ask about this.",
      },
    });
  });

  it("is asked whether or not reply intent is requested", () => {
    expect(buildQuestions(true).asked_how_number_obtained).toEqual(buildQuestions(false).asked_how_number_obtained);
  });

  it("bumps the schema version so old scores are not read as having this answer", () => {
    expect(JEV_SCHEMA_VERSION).toBe("3");
  });
});
