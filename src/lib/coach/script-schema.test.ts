import { describe, expect, it } from "vitest";

import { assertValidClosrScript } from "./script-schema";
import scriptJson from "./closr-script-v0.json";

function validScript(): Record<string, unknown> {
  // Deep-clone via JSON round-trip so mutation in one test never leaks.
  return JSON.parse(JSON.stringify(scriptJson));
}

describe("assertValidClosrScript", () => {
  it("accepts the real closr-script-v0.json unmodified", () => {
    expect(() => assertValidClosrScript(scriptJson)).not.toThrow();
  });

  it("rejects a non-object root", () => {
    expect(() => assertValidClosrScript(null)).toThrow(/root is not an object/);
    expect(() => assertValidClosrScript("nope")).toThrow(/root is not an object/);
  });

  it("rejects a script missing phases", () => {
    const script = validScript();
    delete script.phases;
    expect(() => assertValidClosrScript(script)).toThrow(/missing phases/);
  });

  it("rejects a phase missing display.branches", () => {
    const script = validScript();
    delete (script.phases as Record<string, unknown>[])[0].display;
    expect(() => assertValidClosrScript(script)).toThrow(/missing display\.branches/);
  });

  it("rejects a branch with zero variants", () => {
    const script = validScript();
    const branches = (script.phases as { display: { branches: Record<string, unknown>[] } }[])[0].display.branches;
    branches[0].variants = [];
    expect(() => assertValidClosrScript(script)).toThrow(/malformed branch/);
  });

  it("rejects a variant line with an invalid type", () => {
    const script = validScript();
    const phases = script.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[];
    phases[0].display.branches[0].variants[0].lines[0].type = "sing";
    expect(() => assertValidClosrScript(script)).toThrow(/malformed line/);
  });

  it("rejects a phase missing match.entry_landmarks/advance_landmarks", () => {
    const script = validScript();
    delete (script.phases as Record<string, unknown>[])[0].match;
    expect(() => assertValidClosrScript(script)).toThrow(/missing match/);
  });

  it("rejects a coach_note missing text", () => {
    const script = validScript();
    const notes = (script.phases as { coach_notes: Record<string, unknown>[] }[])[0].coach_notes;
    delete notes[0].text;
    expect(() => assertValidClosrScript(script)).toThrow(/malformed coach_note/);
  });

  it("rejects a script missing objections", () => {
    const script = validScript();
    delete script.objections;
    expect(() => assertValidClosrScript(script)).toThrow(/missing objections/);
  });

  it("rejects an objection missing match.triggers", () => {
    const script = validScript();
    delete (script.objections as Record<string, unknown>[])[0].match;
    expect(() => assertValidClosrScript(script)).toThrow(/missing match\.triggers/);
  });

  it("rejects an objection missing display.overcome", () => {
    const script = validScript();
    const objection = (script.objections as { display: Record<string, unknown> }[])[0];
    delete objection.display.overcome;
    expect(() => assertValidClosrScript(script)).toThrow(/missing\/malformed display fields/);
  });

  it("rejects a script line referencing an unknown {token} placeholder", () => {
    const script = validScript();
    const phases = script.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[];
    phases[0].display.branches[0].variants[0].lines[0].text = "Something about {made_up_token} here.";
    expect(() => assertValidClosrScript(script)).toThrow(/unknown placeholder/);
  });

  it("tolerates {{tone:...}} markup — never mistaken for an unknown {token} placeholder", () => {
    const script = validScript();
    const phases = script.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[];
    phases[0].display.branches[0].variants[0].lines[0].text = "Say this {{tone:warm tone}} then continue.";
    expect(() => assertValidClosrScript(script)).not.toThrow();
  });

  it("rejects an unknown placeholder inside an objection's display.overcome", () => {
    const script = validScript();
    const objection = (script.objections as { display: Record<string, unknown> }[])[0];
    objection.display.overcome = "We can close by {made_up_token}.";
    expect(() => assertValidClosrScript(script)).toThrow(/unknown placeholder/);
  });

  it("rejects an unknown placeholder inside an objection's overcome_by_occupancy value", () => {
    const script = validScript();
    const objection = (script.objections as { id: string; display: Record<string, unknown> }[]).find(
      (o) => o.id === "not_in_rush",
    )!;
    (objection.display.overcome_by_occupancy as Record<string, string>).owner_occupied = "About {made_up_token}.";
    expect(() => assertValidClosrScript(script)).toThrow(/unknown placeholder/);
  });

  it("rejects overcome_by_occupancy with an unrecognized occupancy key", () => {
    const script = validScript();
    const objection = (script.objections as { id: string; display: Record<string, unknown> }[]).find(
      (o) => o.id === "not_in_rush",
    )!;
    (objection.display.overcome_by_occupancy as Record<string, string>).renting = "some text";
    expect(() => assertValidClosrScript(script)).toThrow(/overcome_by_occupancy has a malformed entry/);
  });

  it("rejects an entry_landmark with an invalid speaker — the exact shape that used to slip past a bare Array.isArray check", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: { entry_landmarks: Record<string, unknown>[] } }[];
    const reveal = phases.find((p) => p.id === "reveal")!;
    reveal.match.entry_landmarks[0].speaker = "narrator";
    expect(() => assertValidClosrScript(script)).toThrow(/match\.entry_landmarks\[0\] is malformed/);
  });

  it("rejects a gate missing clear_on.phrases — the exact shape a v0 gates[] was never checked for", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: { gates: { clear_on: Record<string, unknown> }[] } }[];
    const securePositioning = phases.find((p) => p.id === "secure_positioning")!;
    delete securePositioning.match.gates[0].clear_on.phrases;
    expect(() => assertValidClosrScript(script)).toThrow(/match\.gates\[0\] is malformed/);
  });

  it("rejects a counter with a non-numeric goal", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: { counters: Record<string, unknown>[] } }[];
    const reveal = phases.find((p) => p.id === "reveal")!;
    reveal.match.counters[0].goal = "seven";
    expect(() => assertValidClosrScript(script)).toThrow(/match\.counters\[0\] is malformed/);
  });

  it("rejects a timer missing duration_s", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: { timers: Record<string, unknown>[] } }[];
    const securePositioning = phases.find((p) => p.id === "secure_positioning")!;
    delete securePositioning.match.timers[0].duration_s;
    expect(() => assertValidClosrScript(script)).toThrow(/match\.timers\[0\] is malformed/);
  });

  it("rejects pain_words that aren't a string array", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: Record<string, unknown> }[];
    const reveal = phases.find((p) => p.id === "reveal")!;
    reveal.match.pain_words = "not an array";
    expect(() => assertValidClosrScript(script)).toThrow(/match\.pain_words is not a string\[\]/);
  });
});
