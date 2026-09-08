import { describe, expect, it } from "vitest";
import script from "./closr-script-v0.json";
import { splitDisplaySentences } from "./display-sentences";
import type { DisplayLine } from "./script-block";
import { resolveDisplayText } from "./token-resolver";
import { COACH_TOKENS, type ResolvedTokens } from "./types";

const tokens = Object.fromEntries(COACH_TOKENS.map((token) => [token, { value: "Jordan", isPlaceholder: false }])) as ResolvedTokens;
const textOf = (line: DisplayLine) => line.segments.map((segment) => segment.kind === "text" ? segment.value : segment.kind === "tone" ? segment.label : segment.resolved.value).join("");

describe("readable script sentences", () => {
  it("separates the greeting while preserving editable token objects", () => {
    const line: DisplayLine = { type: "say", segments: resolveDisplayText("Hey {seller_name}? Hey {seller_name}, this is {rep_name}!", tokens) };
    const result = splitDisplaySentences(line);
    expect(result.map(textOf)).toEqual(["Hey Jordan? ", "Hey Jordan, this is Jordan!"]);
    expect(result.flatMap((sentence) => sentence.segments).filter((segment) => segment.kind !== "text"))
      .toEqual(line.segments.filter((segment) => segment.kind !== "text"));
  });

  it("keeps outcome numbers with their sentence and places speed on its own line", () => {
    const line: DisplayLine = { type: "say", segments: [{ kind: "text", value: "Two things will happen.\n1. We can help.\n2. We cannot help.\n\nI’m sure speed is important to you right?" }] };
    expect(splitDisplaySentences(line).map((sentence) => textOf(sentence).trim())).toEqual([
      "Two things will happen.", "1. We can help.", "2. We cannot help.", "I’m sure speed is important to you right?",
    ]);
  });

  it("preserves every character, token and tone in every authored script line", () => {
    for (const phase of script.phases) {
      for (const branch of phase.display.branches) {
        for (const variant of branch.variants) {
          for (const authored of variant.lines) {
            const line: DisplayLine = { type: authored.type as DisplayLine["type"], segments: resolveDisplayText(authored.text, tokens) };
            const result = splitDisplaySentences(line);
            expect(result.map(textOf).join(""), authored.id).toBe(textOf(line));
            expect(result.flatMap((sentence) => sentence.segments).filter((segment) => segment.kind !== "text"), authored.id)
              .toEqual(line.segments.filter((segment) => segment.kind !== "text"));
            if (line.type === "note") expect(result).toEqual([line]);
          }
        }
      }
    }
  });
});
