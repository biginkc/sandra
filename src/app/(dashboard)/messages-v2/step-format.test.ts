import { describe, expect, it } from "vitest";

import { readJevScores } from "./step-format";

describe("readJevScores", () => {
  it("reads the bridge's `probabilities` distribution, top-3 by weight", () => {
    const scores = readJevScores({
      classificationRunId: "run-1",
      outcome: "nurture",
      probabilities: {
        nurture: 0.91,
        not_interested: 0.06,
        new_lead: 0.02,
        unclear: 0.01,
      },
      nativeConfidence: 0.91,
    });
    expect(scores).toEqual([
      { label: "nurture", pct: 91 },
      { label: "not_interested", pct: 6 },
      { label: "new_lead", pct: 2 },
    ]);
  });

  it("still accepts the legacy `scores` shape", () => {
    expect(readJevScores({ scores: { wrong_number: 0.8 } })).toEqual([
      { label: "wrong_number", pct: 80 },
    ]);
  });
});
