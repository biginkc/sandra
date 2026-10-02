import { describe, expect, it } from "vitest";

import { selectVoicePhone, toUsVoiceE164 } from "./voice-phone";

describe("voice phone selection", () => {
  it("normalises US shapes and rejects non-US or ambiguous numbers", () => {
    expect(toUsVoiceE164("(816) 555-0142")).toBe("+18165550142");
    expect(toUsVoiceE164("1-816-555-0142")).toBe("+18165550142");
    expect(toUsVoiceE164("+1 816 555 0142")).toBe("+18165550142");
    expect(toUsVoiceE164("+4412345678")).toBeNull();
    expect(toUsVoiceE164("+44 20 7946 0958")).toBeNull();
    expect(toUsVoiceE164("+442079460958")).toBeNull();
    expect(toUsVoiceE164("555-0142")).toBeNull();
    expect(toUsVoiceE164("(116) 555-0142")).toBeNull(); // invalid area code
    expect(toUsVoiceE164("")).toBeNull();
    expect(toUsVoiceE164(null)).toBeNull();
  });

  it("takes the first callable slot in order, landlines included (unlike SMS)", () => {
    expect(selectVoicePhone({ phone_1: "8165550142", phone_2: "8165550143", phone_3: null })).toEqual({ phoneE164: "+18165550142", slot: 1 });
  });

  it("skips non-US numbers and numbers flagged wrong via Norma", () => {
    const contact = { phone_1: "+442079460958", phone_2: "8165550142", phone_3: "8165550143" };
    expect(selectVoicePhone(contact)).toEqual({ phoneE164: "+18165550142", slot: 2 });
    expect(selectVoicePhone(contact, new Set(["+18165550142"]))).toEqual({ phoneE164: "+18165550143", slot: 3 });
    expect(selectVoicePhone(contact, new Set(["+18165550142", "+18165550143"]))).toBeNull();
  });

  it("null contact or no numbers", () => {
    expect(selectVoicePhone(null)).toBeNull();
    expect(selectVoicePhone({ phone_1: null, phone_2: null, phone_3: null })).toBeNull();
  });
});
