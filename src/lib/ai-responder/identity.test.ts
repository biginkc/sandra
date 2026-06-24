import { describe, expect, it } from "vitest";

import { IDENTITY_REPLY_BODY, isIdentityQuestion } from "./identity";

describe("AI responder identity questions", () => {
  it("uses the approved Mel with BMH reply", () => {
    expect(IDENTITY_REPLY_BODY).toBe(
      "I'm sorry I should have mentioned that. I'm Mel with BMH. We're local home buyers since 1998. Any chance you'd consider a cash offer on your property?",
    );
    expect(IDENTITY_REPLY_BODY.length).toBeLessThanOrEqual(160);
  });

  it.each([
    "Who is this?",
    "who's this",
    "whos this?",
    "Who are you.",
    "Who are you delivering for?",
    "Who are you with",
    "It is, who is asking?",
    "I don't have this number saved, who is this?",
    "What company is this?",
    "Who am I talking to?",
    "Identify yourself",
  ])("matches identity challenge: %s", (body) => {
    expect(isIdentityQuestion(body)).toBe(true);
  });

  it.each([
    "yes I own it",
    "how much are you offering?",
    "wrong number",
    "stop texting me",
    "which property is this about?",
  ])("does not match non-identity reply: %s", (body) => {
    expect(isIdentityQuestion(body)).toBe(false);
  });
});
