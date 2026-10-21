import { describe, expect, it } from "vitest";

import matrix from "./__fixtures__/nine-questions-matrix.json";
import {
  actionForNineAnswer,
  classifyNineQuestions,
  buildNineQuestionRequest,
  decideNineQuestions,
  NINE_QUESTION_CUTOFF,
  NINE_QUESTION_GROUPS,
  NINE_QUESTION_IDS,
  NINE_QUESTIONS,
  NINE_HOT_REPLY_NAMES,
  NINE_HOT_REPLY_TEXTS,
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
    // Approved verbatim by Jarrad 2026-10-21.
    asked_stop: "Did the homeowner request that communication cease?",
    hostile: "Was the homeowner rude or hostile?",
    confirmed_owner: "Did the homeowner confirm they are the person or owner we asked about?",
    talked_price: "Did the homeowner mention a price or ask how much we would pay?",
    // Approved verbatim by Jarrad 2026-10-20.
    asked_offer: "Did the homeowner ask what our offer is or how much we would pay?",
    named_price: "Did the homeowner name a price or amount they want?",
    asked_call: "Did the homeowner ask us to call them or give a time to talk?",
  };

  it("the nine plus the three added 2026-10-20, exactly", () => {
    expect(Object.keys(NINE_QUESTIONS).sort()).toEqual(Object.keys(APPROVED).sort());
    for (const id of NINE_QUESTION_IDS) expect(NINE_QUESTIONS[id]).toBe(APPROVED[id]);
    expect(NINE_QUESTION_IDS).toHaveLength(12);
  });

  it("hot reply texts, approved verbatim by Jarrad 2026-10-20", () => {
    expect(NINE_HOT_REPLY_TEXTS).toEqual({
      asked_offer:
        "Thanks for your reply. I'm not authorized to provide offers via SMS, but I'd love to put you in touch with an acquisitions manager. When's a good time to chat?",
      said_yes: "Fantastic. When's a good time for a quick call with an acquisitions manager?",
      named_price: "Thanks, I'll update our records. When's a good time for a quick call with an acquisitions manager?",
    });
    expect(NINE_HOT_REPLY_NAMES).toEqual({ asked_offer: "Asked for offer", said_yes: "Said yes", named_price: "Named a price" });
  });

  it("cutoff is 0.6", () => {
    expect(NINE_QUESTION_CUTOFF).toBe(0.6);
  });

  it("group order (2026-10-20): stop/hostile > wrong person > asked call > asked offer > named price > talked price > open > maybe later > not interested > asked who > confirmed owner", () => {
    expect(NINE_QUESTION_GROUPS).toEqual([
      ["asked_stop", "hostile"],
      ["wrong_person"],
      ["asked_call"],
      ["asked_offer"],
      ["named_price"],
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
    ["open_to_selling", { kind: "hot", reply: "said_yes" }],
    ["talked_price", { kind: "hot", reply: null }],
    ["asked_offer", { kind: "hot", reply: "asked_offer" }],
    ["named_price", { kind: "hot", reply: "named_price" }],
    ["asked_call", { kind: "hot", reply: null }],
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
  it("covers every answer", () => {
    expect(cases.map(([a]) => a).sort()).toEqual([...NINE_QUESTION_IDS, "needs_person"].sort());
  });
});

describe("new tie-breaker on real replies (2026-10-20)", () => {
  // Real seller replies from the 252-reply replay; probabilities shaped like Jev's reads.
  const cases: Array<[string, Partial<Record<NineQuestionId, number>>, NineAnswer]> = [
    ["What's your offer?", { asked_offer: 0.97, talked_price: 0.95, open_to_selling: 0.8 }, "asked_offer"],
    ["I was just offered $395k. What's your offer", { asked_offer: 0.95, named_price: 0.7, talked_price: 0.97, open_to_selling: 0.85 }, "asked_offer"],
    ["Would you consider $450,000?", { named_price: 0.96, talked_price: 0.97, open_to_selling: 0.9, asked_offer: 0.3 }, "named_price"],
    ["Now is fine", { asked_call: 0.93, open_to_selling: 0.7 }, "asked_call"],
    ["Make an offer", { asked_offer: 0.45, open_to_selling: 0.92, talked_price: 0.4 }, "open_to_selling"],
    ["STOP 5 million", { asked_stop: 0.96, named_price: 0.9, talked_price: 0.9, hostile: 0.3 }, "asked_stop"],
  ];
  it.each(cases)("%s", (_reply, p, expected) => {
    const d = decideNineQuestions({ ...none(), ...p });
    expect(d.answer).toBe(expected);
  });
  it("what each one does", () => {
    expect(actionForNineAnswer("asked_offer")).toEqual({ kind: "hot", reply: "asked_offer" });
    expect(actionForNineAnswer("named_price")).toEqual({ kind: "hot", reply: "named_price" });
    expect(actionForNineAnswer("asked_call")).toEqual({ kind: "hot", reply: null });
    expect(actionForNineAnswer("open_to_selling")).toEqual({ kind: "hot", reply: "said_yes" });
    expect(actionForNineAnswer("asked_stop")).toEqual({ kind: "wait_for_person", reason: "asked_stop" });
  });
  it("wrong person beats a call request and a price", () => {
    expect(decideNineQuestions({ ...none(), wrong_person: 0.7, asked_call: 0.99, named_price: 0.99 }).answer).toBe("wrong_person");
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
      asked_offer: "hot",
      named_price: "hot",
      asked_call: "hot",
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

describe("classifyNineQuestions needs all nine answers", () => {
  const respond = (answers: Record<string, unknown>) =>
    (async () => new Response(JSON.stringify({ answers, model: "m" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const full = (over: Record<string, unknown> = {}) =>
    Object.fromEntries(NINE_QUESTION_IDS.map((id) => [id, { choice: "noul", noul: over[id] ?? 0.02 }]));
  const state = { our_last_text_to_homeowner: "x", homeowner_reply: "y" };

  it("a complete response decides", async () => {
    const r = await classifyNineQuestions(state, { fetch: respond(full({ maybe_later: 0.9 })), apiKey: "k" });
    expect(r.answer).toBe("maybe_later");
  });
  it("a partial response (stop / hostile / wrong_person missing) is a failure, never an action", async () => {
    const partial = full({ open_to_selling: 0.9 }) as Record<string, unknown>;
    for (const id of ["asked_stop", "hostile", "wrong_person"]) delete partial[id];
    await expect(classifyNineQuestions(state, { fetch: respond(partial), apiKey: "k" })).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("a non-numeric or out-of-range probability is a failure", async () => {
    await expect(classifyNineQuestions(state, { fetch: respond(full({ hostile: "0.9" })), apiKey: "k" })).rejects.toMatchObject({ kind: "invalid_response" });
    await expect(classifyNineQuestions(state, { fetch: respond(full({ hostile: 1.4 })), apiKey: "k" })).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
