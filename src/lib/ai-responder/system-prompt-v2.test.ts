import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PROMPT_PATH = path.resolve(
  __dirname,
  "../../../docs/ai-responder/system-prompt-v2.txt",
);
const prompt = readFileSync(PROMPT_PATH, "utf8");

describe("ai responder system prompt v2 artifact", () => {
  it("contains the 16 decision examples from the approved routing contract", () => {
    for (let i = 1; i <= 16; i += 1) {
      expect(prompt).toMatch(new RegExp(`^${i}\\) `, "m"));
    }
  });

  it("pins the high-risk examples to the intended terminal actions", () => {
    expect(prompt).toMatch(/8\) "NOT SELLING\. STOP" -> opt_out/);
    expect(prompt).toMatch(/11\) "please delete my number" -> opt_out/);
    expect(prompt).toMatch(/14\) "I will find you and make you pay" -> close_not_interested/);
  });

  it("pins wrong-number examples to the intended scopes", () => {
    expect(prompt).toMatch(/4\) "I don't own that house" -> close_wrong_number, wrong_scope="this_property"/);
    expect(prompt).toMatch(/5\) "You've got the wrong number, I never owned any property" -> close_wrong_number, wrong_scope="all"/);
  });

  it("states that opt-out sends no body and wrong number requires wrong_scope", () => {
    expect(prompt).toMatch(/action = "opt_out"\. DO NOT SEND ANYTHING/);
    expect(prompt).toMatch(/wrong_scope: required ONLY for action=close_wrong_number/);
  });
});
