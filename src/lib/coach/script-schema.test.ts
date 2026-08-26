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
    expect(() => assertValidClosrScript(script)).toThrow(/missing display\.acknowledge\/disarm\/overcome/);
  });
});
