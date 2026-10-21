import { describe, expect, it } from "vitest";

import { hasVoicemailFields, isValidVoicemailDropStep, voicemailDropTimelineText } from "./voicemail-drop-step";

const base = { action_type: "send_voicemail_drop", template_body: null, template_id: null, template_category: null, target_status: null };

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
    const row = { id: "d", status: "failed", reason: null, reason_code: "4002", proof_url: null, audio_kind: "tts",
      queued_at: null, completed_at: null, created_at: "2026-10-20T00:00:00Z" };
    expect(voicemailDropTimelineText(row)).toEqual({ title: "Voicemail not delivered", detail: "Voicemail box full." });
    expect(voicemailDropTimelineText({ ...row, reason_code: null, reason: "carrier rejected" }).detail).toBe("Carrier rejected.");
    expect(voicemailDropTimelineText({ ...row, status: "queued" }).title).toBe("Voicemail queued");
    expect(voicemailDropTimelineText({ ...row, status: "delivered", audio_kind: "media" }).detail).toBe("Left a recorded message.");
  });
});
