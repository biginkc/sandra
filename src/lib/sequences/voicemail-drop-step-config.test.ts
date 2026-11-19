import { describe, expect, it } from "vitest";

import {
  hasDropCowboyRandomVariant,
  voicemailScriptProblem,
  voicemailStepIsSpoken,
  hasVoicemailFields,
  isValidVoicemailDropStep,
  visibleVoicemailDrops,
  voicemailDropTimelineText,
} from "./voicemail-drop-step-config";

const base = { action_type: "send_voicemail_drop", template_body: null, template_id: null, template_category: null, target_status: null, vm_voice_id: "voice-1" };

describe("voicemail drop step rules", () => {
  it("requires exactly one of recording or script", () => {
    expect(isValidVoicemailDropStep({ ...base, vm_tts_body: "Hi" })).toBe(true);
    expect(isValidVoicemailDropStep({ ...base, vm_media_id: "m1" })).toBe(true);
    expect(isValidVoicemailDropStep({ ...base, vm_media_id: "m1", vm_tts_body: "Hi" })).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_tts_body: "  " })).toBe(false);
  });
  it("rejects long scripts and SMS/status fields", () => {
    expect(isValidVoicemailDropStep({ ...base, vm_tts_body: "a".repeat(1200) })).toBe(true);
    expect(isValidVoicemailDropStep({ ...base, vm_tts_body: "a".repeat(1201) })).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_tts_body: "Hi", template_body: "x" })).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_tts_body: "Hi", target_status: "dead" })).toBe(false);
  });
  it("rejects single-brace merge fields but accepts double-brace ones", () => {
    expect(isValidVoicemailDropStep({ ...base, vm_tts_body: "Hi {first_name}" })).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_tts_body: "Hi {{first_name}} at {{property_address}}" })).toBe(true);
  });
  it("detects voicemail fields on other step types", () => {
    expect(hasVoicemailFields({ action_type: "send_sms", vm_voice_id: "v" })).toBe(true);
    expect(hasVoicemailFields({ action_type: "send_sms", vm_voice_id: null })).toBe(false);
  });
  it("words timeline states plainly", () => {
    const row = { id: "d", status: "failed", attempt_outcome: "queued", reason: null, reason_code: "4002", proof_url: null, audio_kind: "tts",
      queued_at: null, completed_at: null, created_at: "2026-10-20T00:00:00Z" };
    expect(voicemailDropTimelineText(row)).toEqual({ title: "Voicemail not delivered", detail: "Voicemail box full." });
    expect(voicemailDropTimelineText({ ...row, reason_code: null, reason: "carrier rejected" }).detail).toBe("Carrier rejected.");
    expect(voicemailDropTimelineText({ ...row, status: "queued" }).title).toBe("Voicemail queued");
    expect(voicemailDropTimelineText({ ...row, status: "delivered", audio_kind: "media" }).detail).toBe("Left a recorded message.");
  });
  it("a script needs a voice (own or default); a recording does not", () => {
    expect(isValidVoicemailDropStep({ ...base, vm_voice_id: null, vm_tts_body: "Hi" })).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_voice_id: " ", vm_tts_body: "Hi" }, "voice-default")).toBe(true);
    expect(isValidVoicemailDropStep({ ...base, vm_voice_id: null, vm_media_id: "m1" })).toBe(true);
  });
  it("hides drops Drop Cowboy never queued from the lead timeline", () => {
    const rows = [
      { id: "a", attempt_outcome: "queued" },
      { id: "b", attempt_outcome: "not_queued" },
      { id: "c", attempt_outcome: "unknown" },
    ];
    expect(visibleVoicemailDrops(rows).map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("rotation is a third source: exactly one of recording / script / group", () => {
    expect(isValidVoicemailDropStep({ ...base, vm_template_category: "Group A" })).toBe(true);
    expect(isValidVoicemailDropStep({ ...base, vm_template_category: "Group A", vm_tts_body: "Hi" })).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_template_category: "Group A", vm_media_id: "m1" })).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_template_category: "  " })).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_template_category: "Group A", vm_voice_id: null })).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_template_category: "Group A", template_category: "SMS pool" })).toBe(false);
  });
  it("a rotation group on a non-drop step counts as a voicemail field", () => {
    expect(hasVoicemailFields({ action_type: "send_sms", vm_template_category: "Group A" })).toBe(true);
  });
  it("scripts and rotations are spoken; recordings are not", () => {
    expect(voicemailStepIsSpoken({ ...base, vm_template_category: "Group A" })).toBe(true);
    expect(voicemailStepIsSpoken({ ...base, vm_tts_body: "Hi" })).toBe(true);
    expect(voicemailStepIsSpoken({ ...base, vm_media_id: "m1" })).toBe(false);
  });
  it("blocks Drop Cowboy [a/b] random variants in scripts", () => {
    expect(hasDropCowboyRandomVariant("[Hi/Hello] there")).toBe(true);
    expect(hasDropCowboyRandomVariant("Hi [Norma] here")).toBe(false);
    expect(hasDropCowboyRandomVariant("Hi a/b")).toBe(false);
    expect(isValidVoicemailDropStep({ ...base, vm_tts_body: "[Hi/Hello] {{first_name}}" })).toBe(false);
  });
  it("names the problem with one script", () => {
    expect(voicemailScriptProblem("Hi {{first_name}}")).toBeNull();
    expect(voicemailScriptProblem(" ")).toMatch(/Write the script/);
    expect(voicemailScriptProblem("a".repeat(1201))).toMatch(/1,200/);
    expect(voicemailScriptProblem("Hi {first_name}")).toMatch(/double braces/);
    expect(voicemailScriptProblem("[Hi/Hello]")).toMatch(/\[this\/that\]/);
  });
});
