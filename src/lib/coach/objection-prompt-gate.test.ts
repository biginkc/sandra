import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));
import { isObjectionPromptAllowed } from "./objection-prompt-gate";

describe("objection prompt display gate", () => {
  it("allows every user when the master switch is exactly 1", () => {
    expect(isObjectionPromptAllowed("1")).toBe(true);
  });
  it("rejects every other master switch value", () => {
    expect(isObjectionPromptAllowed(undefined)).toBe(false);
    expect(isObjectionPromptAllowed("")).toBe(false);
    expect(isObjectionPromptAllowed("0")).toBe(false);
    expect(isObjectionPromptAllowed("true")).toBe(false);
    expect(isObjectionPromptAllowed(" 1 ")).toBe(false);
  });
  it("passes only a boolean through the client provider boundary", () => {
    const layout = readFileSync("src/app/(dashboard)/layout.tsx", "utf8");
    const provider = readFileSync("src/components/coach/objection-prompt-context.tsx", "utf8");
    expect(layout).not.toContain("COACH_OBJECTION_PROMPT_OPERATOR_ALLOWLIST");
    expect(layout).toContain("<ObjectionPromptProvider enabled={objectionPromptEnabled}>");
    expect(provider).not.toContain("COACH_OBJECTION_PROMPT_OPERATOR_ALLOWLIST");
    expect(provider).toContain("enabled: boolean");
  });
});
