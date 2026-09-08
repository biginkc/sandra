import { describe, expect, it } from "vitest";

import { buildCoachSectionScriptBlock } from "./script-block";
import { resolveCoachTokens, type DisplayTextSegment } from "./token-resolver";
import type { CoachCallContext } from "./types";

const context: CoachCallContext = {
  sellerName: "Jordan Ellis",
  propertyAddress: "1842 Lantern Finch Lane",
  propertyCounty: null,
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "moving closer to an adult daughter",
  leadId: null,
  sellerPhoneE164: "+18165440196",
  coldCallerName: "Rose",
  yearBuilt: "1978",
  leadSource: null,
  occupancy: "owner_occupied",
};

// Independently transcribed from the official Google Doc, tab t.0:
// 1ab9k0VIUQ4kkSTmdR5XV7qeuiRe2-czgmKGouM-lCag (read 2026-09-08).
// Only the approved name, address, assistant and motivation placeholders
// are substituted here. Expectations must not be derived from script JSON.
const greeting = "Hey Jordan? Hey Jordan, this is Alex Rep!";
const sourceOpeners = {
  cold_call: "It looks like you spoke to one of my assistants Rose a little bit ago about your property on 1842 Lantern Finch Lane, they said you may need help with moving closer to an adult daughter?",
  fsbo: "I saw your place at 1842 Lantern Finch Lane was listed For Sale by Owner. Were you looking to sell to someone planning to live there, or would you want me to check if our team can get you approved for an all-cash offer?",
  sms: "I see you just responded to our teams text about getting an offer on 1842 Lantern Finch Lane, is this something you want to sell immediately or just looking at possible options while you have some free time?",
  d4d: "I’m holding a copy of your tax records here for the property at 1842 Lantern Finch Lane, and my team just wanted me to ask, would you be open to a cash offer, or are you planning to hold onto it for now?",
};

function displayedText(segments: DisplayTextSegment[]): string {
  return segments.map((segment) => {
    if (segment.kind === "text") return segment.value;
    if (segment.kind === "tone") return segment.label;
    return segment.resolved.value;
  }).join("");
}

function opener(leadSource: string | null, override?: string) {
  const block = buildCoachSectionScriptBlock(
    "introduction.opener",
    resolveCoachTokens(context),
    { leadSource, occupancy: context.occupancy },
    override ? { Opener: override } : {},
  );
  expect(block?.branches).toHaveLength(1);
  return block!.branches[0];
}

function spokenLines(branch: ReturnType<typeof opener>): string[] {
  return branch.selected.lines
    .filter((line) => line.type === "say")
    .map((line) => displayedText(line.segments));
}

describe("official source opener fidelity through the section builder", () => {
  it.each([null, "manual", "import", "unknown-source"])(
    "keeps every source opener visible in source order when source is %s",
    (source) => {
      const branch = opener(source);
      expect(branch.selected.key).toBe("default");
      expect(spokenLines(branch)).toEqual([
        greeting,
        sourceOpeners.cold_call,
        sourceOpeners.fsbo,
        sourceOpeners.sms,
        sourceOpeners.d4d,
      ]);
      expect(branch.selected.lines.filter((line) => line.type === "note")
        .map((line) => displayedText(line.segments))).toEqual([
        "Cold call:", "FSBO:", "SMS reply:", "Driving for dollars:",
      ]);
    },
  );

  it.each([
    ["cold_call", "cold_call"],
    ["sms", "sms"],
    ["driving_for_dollars", "d4d"],
  ] as const)("keeps the mapped %s source on its complete specific opener", (source, key) => {
    const branch = opener(source);
    expect(branch.selected.key).toBe(key);
    expect(spokenLines(branch)).toEqual([greeting, sourceOpeners[key]]);
  });

  it.each(["cold_call", "fsbo", "sms", "d4d"] as const)(
    "preserves the complete manually selected %s opener over source selection",
    (key) => {
      const branch = opener("sms", key);
      expect(branch.selected.key).toBe(key);
      expect(spokenLines(branch)).toEqual([greeting, sourceOpeners[key]]);
    },
  );

  it("allows the rep to restore all openers even with a mapped source", () => {
    expect(spokenLines(opener("sms", "default"))).toEqual([
      greeting, sourceOpeners.cold_call, sourceOpeners.fsbo, sourceOpeners.sms, sourceOpeners.d4d,
    ]);
  });
});
