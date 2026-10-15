import { describe, expect, it } from "vitest";

import matrix from "./__fixtures__/nine-questions-matrix.json";
import {
  actionForNineAnswer,
  buildNineQuestionRequest,
  decideNineQuestions,
  NINE_QUESTION_CUTOFF,
  NINE_QUESTION_GROUPS,
  NINE_QUESTION_IDS,
  NINE_QUESTIONS,
  type NineAnswer,
  type NineQuestionId,
} from "./nine-questions";

const none = (): Record<NineQuestionId, number> =>
  Object.fromEntries(NINE_QUESTION_IDS.map((id) => [id, 0])) as Record<NineQuestionId, number>;

describe("approved text is pinned byte for byte", () => {
  // Copied verbatim from the approved list. Any edit here or in nine-questions.ts needs
  // Jarrad's approval of the exact new text.
  const APPROVED: Record<NineQuestionId, string> = {
    open_to_selling: "Did the homeowner say they are open to selling the property or want an offer?",
    maybe_later: "Did the homeowner say they might sell later, but not right now?",
    asked_who: "Did the homeowner ask who is texting them or why?",
    not_interested: "Did the homeowner say they are not interested in selling?",
    wrong_person: "Did the homeowner say we have the wrong person, or that they don't own the property?",
    asked_stop: "Did the homeowner ask to stop receiving texts?",
    hostile: "Was the homeowner rude or hostile?",
    confirmed_owner: "Did the homeowner confirm they are the person or owner we asked about?",
    talked_price: "Did the homeowner mention a price or ask how much we would pay?",
  };

  it("nine questions, exactly", () => {
    expect(Object.keys(NINE_QUESTIONS).sort()).toEqual(Object.keys(APPROVED).sort());
    for (const id of NINE_QUESTION_IDS) expect(NINE_QUESTIONS[id]).toBe(APPROVED[id]);
    expect(NINE_QUESTION_IDS).toHaveLength(9);
  });

  it("cutoff is 0.6", () => {
    expect(NINE_QUESTION_CUTOFF).toBe(0.6);
  });

  it("group order is stop/hostile > wrong person > price > open > maybe later > not interested > asked who > confirmed owner", () => {
    expect(NINE_QUESTION_GROUPS).toEqual([
      ["asked_stop", "hostile"],
      ["wrong_person"],
      ["talked_price"],
      ["open_to_selling"],
      ["maybe_later"],
      ["not_interested"],
      ["asked_who"],
      ["confirmed_owner"],
    ]);
  });

  it("the request sent to Jev carries each question verbatim", () => {
    const req = buildNineQuestionRequest({ our_last_text_to_homeowner: "x", homeowner_reply: "y" });
    for (const id of NINE_QUESTION_IDS) expect(req.questions[id]).toEqual({ type: "noul", instructions: APPROVED[id] });
  });
});

describe("decideNineQuestions", () => {
  it("cutoff boundary: 0.6 exactly is yes, 0.5999 is no", () => {
    expect(decideNineQuestions({ ...none(), maybe_later: 0.6 }).answer).toBe("maybe_later");
    expect(decideNineQuestions({ ...none(), maybe_later: 0.5999 }).answer).toBe("needs_person");
    expect(decideNineQuestions({ ...none(), maybe_later: 0.6 }).chosen).toEqual({ id: "maybe_later", probability: 0.6 });
  });

  it("invalid or missing probabilities are never yes", () => {
    for (const bad of [undefined, null, "0.9", Number.NaN, Number.POSITIVE_INFINITY, 1.01, -0.1, {}]) {
      const d = decideNineQuestions({ open_to_selling: bad });
      expect(d.answer).toBe("needs_person");
      expect(d.probabilities.open_to_selling).toBeNull();
    }
    expect(decideNineQuestions({}).answer).toBe("needs_person");
  });

  it("every group beats every later group (first yes wins)", () => {
    const order = NINE_QUESTION_GROUPS.map((g) => g[0]!);
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        // the later question is far more certain, the earlier only just clears the cutoff
        const d = decideNineQuestions({ ...none(), [order[i]!]: 0.6, [order[j]!]: 0.99 });
        expect(d.answer).toBe(order[i]);
      }
    }
  });

  it("asked_stop vs hostile: higher probability reported, tie goes to asked_stop", () => {
    expect(decideNineQuestions({ ...none(), asked_stop: 0.7, hostile: 0.9 }).answer).toBe("hostile");
    expect(decideNineQuestions({ ...none(), asked_stop: 0.9, hostile: 0.7 }).answer).toBe("asked_stop");
    expect(decideNineQuestions({ ...none(), asked_stop: 0.8, hostile: 0.8 }).answer).toBe("asked_stop");
    // only one clears the cutoff
    expect(decideNineQuestions({ ...none(), asked_stop: 0.5, hostile: 0.6 }).answer).toBe("hostile");
    expect(decideNineQuestions({ ...none(), asked_stop: 0.6, hostile: 0.5 }).answer).toBe("asked_stop");
  });

  it("records every probability, the winner and the cutoff", () => {
    const d = decideNineQuestions({ ...none(), asked_who: 0.7 });
    expect(d).toMatchObject({ answer: "asked_who", cutoff: 0.6, chosen: { id: "asked_who", probability: 0.7 } });
    expect(Object.keys(d.probabilities).sort()).toEqual([...NINE_QUESTION_IDS].sort());
  });

  it("nothing reaches the cutoff: needs_person with no chosen question", () => {
    const d = decideNineQuestions({ ...none(), confirmed_owner: 0.59 });
    expect(d.answer).toBe("needs_person");
    expect(d.chosen).toBeNull();
  });
});

describe("actionForNineAnswer", () => {
  const cases: Array<[NineAnswer, unknown]> = [
    ["open_to_selling", { kind: "hot" }],
    ["talked_price", { kind: "hot" }],
    ["maybe_later", { kind: "reply_and_drip", reply: "nurture", drip: "Maybe later", skipFirstStep: false }],
    ["asked_who", { kind: "reply_and_drip", reply: "identity", drip: "Asked who is texting", skipFirstStep: true }],
    ["not_interested", { kind: "reply_and_drip", reply: "not_interested", drip: "Not interested", skipFirstStep: false }],
    ["wrong_person", { kind: "reply_and_close_wrong_person" }],
    ["confirmed_owner", { kind: "drip_only", drip: "Confirmed owner" }],
    ["asked_stop", { kind: "wait_for_person", reason: "asked_stop" }],
    ["hostile", { kind: "wait_for_person", reason: "hostile" }],
    ["needs_person", { kind: "wait_for_person", reason: "needs_person" }],
  ];
  it.each(cases)("%s", (answer, action) => {
    expect(actionForNineAnswer(answer)).toEqual(action);
  });
  it("covers all ten answers", () => {
    expect(cases.map(([a]) => a).sort()).toEqual([...NINE_QUESTION_IDS, "needs_person"].sort());
  });
});

describe("recorded matrix (30 scenarios x 3 wordings, synthetic)", () => {
  type Entry = {
    scenario: string;
    our_last_text: string;
    homeowner_reply: string;
    probabilities: Record<string, unknown>;
    expected_answer: NineAnswer;
  };
  const entries = matrix.entries as Entry[];

  it("is 90 entries over 30 scenarios and says it is synthetic", () => {
    expect(entries).toHaveLength(90);
    expect(new Set(entries.map((e) => e.scenario)).size).toBe(30);
    expect(matrix._synthetic).toMatch(/SYNTHETIC/);
  });

  it.each(entries.map((e) => [`${e.scenario} / ${e.homeowner_reply}`, e] as const))("%s", (_name, e) => {
    const d = decideNineQuestions(e.probabilities);
    expect(d.answer).toBe(e.expected_answer);
    const action = actionForNineAnswer(d.answer);
    const expectedKind = {
      open_to_selling: "hot",
      talked_price: "hot",
      maybe_later: "reply_and_drip",
      asked_who: "reply_and_drip",
      not_interested: "reply_and_drip",
      wrong_person: "reply_and_close_wrong_person",
      confirmed_owner: "drip_only",
      asked_stop: "wait_for_person",
      hostile: "wait_for_person",
      needs_person: "wait_for_person",
    }[d.answer];
    expect(action.kind).toBe(expectedKind);
  });
});
