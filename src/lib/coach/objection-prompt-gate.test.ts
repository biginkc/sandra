import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));
import { isObjectionPromptAllowed } from "./objection-prompt-gate";

describe("objection prompt display gate", () => {
  it("requires exact switch and allowlisted auth user id", () => {
    expect(isObjectionPromptAllowed("user-b", "1", "user-a, user-b ")).toBe(true);
    expect(isObjectionPromptAllowed("user-b", "true", "user-b")).toBe(false);
    expect(isObjectionPromptAllowed("user-b", "1", "")).toBe(false);
    expect(isObjectionPromptAllowed("user-b", "1", "user-a, user-c")).toBe(false);
  });
  it("passes only a boolean through the client provider boundary", () => {
    const layout = readFileSync("src/app/(dashboard)/layout.tsx", "utf8");
    const provider = readFileSync("src/components/coach/objection-prompt-context.tsx", "utf8");
    expect(layout).toContain("<ObjectionPromptProvider enabled={objectionPromptEnabled}>");
    expect(provider).not.toContain("COACH_OBJECTION_PROMPT_OPERATOR_ALLOWLIST");
    expect(provider).toContain("enabled: boolean");
  });
});
