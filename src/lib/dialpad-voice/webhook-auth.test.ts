import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDialpadVoiceEvent } from "./webhook-auth";

const secret = "fixture-voice-webhook-secret";
function sign(payload: unknown, header: unknown = { alg: "HS256", typ: "JWT" }, key = secret) {
  const parts = [header, payload].map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"));
  return [...parts, createHmac("sha256", key).update(parts.join(".")).digest("base64url")].join(".");
}

describe("Dialpad voice event authentication", () => {
  it("accepts a signed event without requiring undocumented temporal claims", () => {
    const event = { call_id: "123", state: "recording", target: { id: "456", type: "user" } };
    expect(verifyDialpadVoiceEvent(sign(event), secret)).toEqual(event);
  });
  it("rejects altered payloads and a different subscription secret", () => {
    const token = sign({ state: "connected" });
    const [h, , s] = token.split(".");
    expect(verifyDialpadVoiceEvent(`${h}.${Buffer.from('{"state":"hangup"}').toString("base64url")}.${s}`, secret)).toBeNull();
    expect(verifyDialpadVoiceEvent(token, "different-secret")).toBeNull();
  });
  it("rejects algorithm confusion even when the HMAC matches", () => {
    for (const alg of ["none", "RS256", undefined]) {
      expect(verifyDialpadVoiceEvent(sign({}, { alg }), secret)).toBeNull();
    }
    expect(verifyDialpadVoiceEvent(sign({}, { alg: "HS256", crit: ["b64"] }), secret)).toBeNull();
  });
  it("rejects unconfigured secrets, unsigned JSON and malformed or oversized bodies", () => {
    for (const raw of ["", "{}", "x.y.z", "a.b.c.d", "x".repeat(1_048_577)]) {
      expect(verifyDialpadVoiceEvent(raw, secret)).toBeNull();
    }
    expect(verifyDialpadVoiceEvent(sign({}, { alg: "HS256" }, ""), "")).toBeNull();
  });
  it("rejects non-object event payloads", () => {
    for (const payload of [null, [], "event", 1]) {
      expect(verifyDialpadVoiceEvent(sign(payload), secret)).toBeNull();
    }
  });
});
