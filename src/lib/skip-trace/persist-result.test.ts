import { describe, expect, it } from "vitest";

import { normalizePhone } from "./persist-result";

describe("normalizePhone", () => {
  it("prepends +1 to a bare 10-digit US number (Tracerfy's default)", () => {
    expect(normalizePhone("8167416576")).toBe("+18167416576");
  });

  it("prepends + to an 11-digit number starting with 1", () => {
    expect(normalizePhone("18167416576")).toBe("+18167416576");
  });

  it("keeps an already-E.164 number unchanged", () => {
    expect(normalizePhone("+18167416576")).toBe("+18167416576");
  });

  it("strips parentheses, dashes, dots, spaces", () => {
    expect(normalizePhone("(816) 741-6576")).toBe("+18167416576");
    expect(normalizePhone("816.741.6576")).toBe("+18167416576");
    expect(normalizePhone("816 741 6576")).toBe("+18167416576");
  });

  it("does not guess for non-US lengths", () => {
    // 7 digits — local form, can't infer country code
    expect(normalizePhone("7416576")).toBe("7416576");
    // 12 digits not starting with + or 1 — leave alone
    expect(normalizePhone("447911123456")).toBe("447911123456");
  });

  it("two equivalent inputs normalize to the same string (dedup safe)", () => {
    const a = normalizePhone("(816) 741-6576");
    const b = normalizePhone("8167416576");
    const c = normalizePhone("+1 816 741 6576");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
