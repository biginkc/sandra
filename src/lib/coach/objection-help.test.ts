import { describe, expect, it } from "vitest";

import { CLOSR_SCRIPT } from "./script-block";
import { resolveCoachTokens } from "./token-resolver";
import type { CoachCallContext } from "./types";
import { findObjectionHelp } from "./objection-help";

const context: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  authenticatedRepName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "move closer to family",
  leadId: "lead-1",
  sellerPhoneE164: "+18165559876",
  coldCallerName: null,
  yearBuilt: "1987",
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

const tokens = resolveCoachTokens(context);

describe("findObjectionHelp", () => {
  it("uses only finalized seller speech and returns all three approved beats", () => {
    const result = findObjectionHelp([
      { speaker: "rep", text: "I do not trust that estimate.", isFinal: true },
      { speaker: "seller", text: "I don't trust wholesalers.", isFinal: false },
      { speaker: "seller", text: "I don't trust wholesalers because I heard bad things.", isFinal: true },
    ], tokens, context.occupancy);

    expect(result).toMatchObject({
      kind: "match",
      objectionId: "dont_trust",
      label: "Dont Trust",
      matchedTrigger: "heard bad things",
      acknowledge: "Yeah, you're completely right.",
    });
    if (result.kind === "match") {
      expect(result.disarm).toContain("don't know enough about us");
      expect(result.overcome).toContain("What would make you feel more confident");
    }
  });

  it("returns a truthful no-clear-objection result instead of guessing", () => {
    expect(findObjectionHelp([
      { speaker: "seller", text: "The kitchen was updated last year and looks great.", isFinal: true },
      { speaker: "seller", text: "Okay, thanks.", isFinal: true },
    ], tokens, context.occupancy)).toEqual({
      kind: "no_match",
      message: "No clear objection was found in the finalized homeowner speech.",
    });
  });

  it("uses the occupancy-specific approved track and resolves seller tokens", () => {
    const result = findObjectionHelp([
      { speaker: "seller", text: "I need to talk to my spouse before deciding.", isFinal: true },
    ], tokens, context.occupancy);

    expect(result).toMatchObject({ kind: "match", objectionId: "talk_to_spouse" });
    if (result.kind === "match") {
      expect(result.disarm).toContain("Jane, I have two available slots");
      expect(result.disarm).not.toContain("{seller_name}");
    }

    const tenantTokens = resolveCoachTokens({ ...context, occupancy: "tenant_occupied" });
    const tenant = findObjectionHelp([
      { speaker: "seller", text: "I'm not in a rush to sell this rental at all.", isFinal: true },
    ], tenantTokens, "tenant_occupied");
    expect(tenant).toMatchObject({ kind: "match", objectionId: "not_in_rush" });
    if (tenant.kind === "match") expect(tenant.overcome).toContain("landlord duties");
  });

  // Every catalog trigger must still route to its objection, but not every
  // trigger is safe to trust alone — several are single ordinary words or
  // short generic fragments ("inspections", "how much", "my number",
  // "zillow") that also occur in completely unrelated remarks (see the
  // false-positive corpus below). So instead of firing each trigger in
  // isolation, this exercises one genuine, borderline-but-realistic
  // sentence per objection — the kind of thing a seller actually says —
  // and confirms every objection is still reachable through it.
  const PER_OBJECTION_PHRASING: Record<string, string> = {
    price_too_low: "That offer is way less than what we were hoping for — honestly it's kind of insulting.",
    list_with_realtor: "We might just put it on the market with a real estate agent instead.",
    zillow_worth: "Zillow already appraised it for way more than that.",
    not_in_rush: "We are not in a rush to sell this house at all.",
    talk_to_spouse: "I need to talk to my spouse before deciding.",
    dont_trust: "This whole thing feels like a scam and I just don't trust it.",
    end_buyer: "Are you the buyer, or is someone else actually buying this?",
    no_showings: "I don't want strangers walking through my house for showings.",
    proof_of_funds: "We'll need earnest money and proof of funds before we go further.",
    right_price_only: "I just want the right price — my number is firm and that's final.",
    straight_to_offer: "Just give me the offer, what's your offer?",
  };

  it("keeps every authored objection connected to the click-driven catalog matcher via genuine phrasing", () => {
    expect(Object.keys(PER_OBJECTION_PHRASING).sort()).toEqual(CLOSR_SCRIPT.objections.map((o) => o.id).sort());
    for (const objection of CLOSR_SCRIPT.objections) {
      const result = findObjectionHelp([
        { speaker: "seller", text: PER_OBJECTION_PHRASING[objection.id], isFinal: true },
      ], tokens, null);
      expect(result, objection.id).toMatchObject({ kind: "match", objectionId: objection.id });
    }
  });

  it("does not invent an objection from a single ordinary short trigger word with no corroborating evidence", () => {
    // Each of these is a bare catalog trigger fired alone with no second
    // trigger and no positive context — the exact shape the old matcher
    // treated as sufficient proof, and precisely what a real transcript
    // does NOT provide when the word is being used for its ordinary,
    // non-objection meaning.
    const bareWeakTriggers = [
      "too low", "that's low", "insulting", "list it", "realtor", "zillow", "zestimate", "appraised",
      "appraiser said", "worth more", "no hurry", "not motivated", "no rush", "scam", "don't trust",
      "wholesaler", "actually buying", "end buyer", "earnest money", "right price", "who are you",
    ];
    for (const trigger of bareWeakTriggers) {
      const result = findObjectionHelp([
        { speaker: "seller", text: `I want to say ${trigger}.`, isFinal: true },
      ], tokens, null);
      expect(result, trigger).toMatchObject({ kind: "no_match" });
    }
  });

  it("does not misclassify ordinary shared-vocabulary speech as an objection (PR #457 review round 1)", () => {
    // These reproduce Codex's exact false-positive repros plus a broader
    // corpus of ordinary real-estate-call remarks sampled from this
    // project's own fixtures and probe testing — none of them are the
    // seller pushing back on anything.
    const ordinaryLines = [
      "My number is 816-555-1234, feel free to text me.", // Codex repro: was right_price_only
      "How much time do you need for the walkthrough?", // Codex repro: was straight_to_offer
      "We had inspections done last year and everything passed.", // Codex repro: was no_showings
      "I need to sell because the repairs are too expensive.",
      "The roof is leaking badly and the repairs are expensive.",
      "The kitchen was updated last year and looks great.",
      "The vacant property is draining our savings and we need a clean closing.",
      "We need to sell before October because the carrying costs are becoming painful.",
      "My job is moving and I cannot afford two homes after next month.",
      "The house has a new roof and fresh paint.",
      "The walkthrough this morning went fine, no issues.",
      "We've had two showings already through the other agent.",
      "I appraised the roof repair cost at around three thousand dollars myself.",
      "The ceiling in the basement is too low for a full renovation.",
      "I don't trust myself to remember all the paperwork you need.",
      "Strangers keep knocking on my door about solar panels, it's annoying.",
      "We had a scam call last week about our home warranty, glad this is different.",
      "List it up mentally: roof, furnace, water heater all replaced in the last five years.",
      "We're actually buying a new home in Florida once this sells.",
      "Zillow said the roof needs work within five years.",
      "How much longer is this call going to take, I have somewhere to be?",
      "Who are you again, sorry I didn't catch your name?",
      "A few people came through last week for the home inspection.",
    ];
    for (const text of ordinaryLines) {
      const result = findObjectionHelp([{ speaker: "seller", text, isFinal: true }], tokens, null);
      expect(result, text).toMatchObject({ kind: "no_match" });
    }
  });

  it("prefers a more specific cue before a shorter overlapping cue", () => {
    const result = findObjectionHelp([
      { speaker: "seller", text: "Just give me the offer — what's your offer?", isFinal: true },
    ], tokens, null);
    expect(result).toMatchObject({ kind: "match", objectionId: "straight_to_offer", matchedTrigger: "just give me the offer" });
  });
});
