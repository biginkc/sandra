import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parseTwilioInbound,
  verifyTwilioSignature,
} from "./twilio-receiver";

const AUTH_TOKEN = "test_auth_token_abcdef";
const URL = "https://example.test/api/webhooks/test-receiver";

/** Mirror of the algorithm in verifyTwilioSignature — used to compute
 *  the signature a real Twilio delivery would include. */
function signFixture(form: Record<string, string>): string {
  const sorted = Object.keys(form).sort();
  let canonical = URL;
  for (const k of sorted) canonical += k + form[k];
  return crypto.createHmac("sha1", AUTH_TOKEN).update(canonical).digest("base64");
}

describe("verifyTwilioSignature", () => {
  it("accepts a correctly-signed payload", () => {
    const form = {
      MessageSid: "SM1",
      From: "+18163706846",
      To: "+15558675309",
      Body: "hello",
    };
    const sig = signFixture(form);
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        fullUrl: URL,
        form,
        signatureHeader: sig,
      }),
    ).toBe(true);
  });

  it("rejects when any form field is tampered", () => {
    const form = { MessageSid: "SM1", From: "+1", To: "+1", Body: "hi" };
    const sig = signFixture(form);
    const tampered = { ...form, Body: "not hi" };
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        fullUrl: URL,
        form: tampered,
        signatureHeader: sig,
      }),
    ).toBe(false);
  });

  it("rejects when URL is tampered", () => {
    const form = { MessageSid: "SM1", From: "+1", To: "+1", Body: "hi" };
    const sig = signFixture(form);
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        fullUrl: URL + "?tamper=1",
        form,
        signatureHeader: sig,
      }),
    ).toBe(false);
  });

  it("rejects when auth token is wrong", () => {
    const form = { MessageSid: "SM1", From: "+1", To: "+1", Body: "hi" };
    const sig = signFixture(form);
    expect(
      verifyTwilioSignature({
        authToken: "wrong_token",
        fullUrl: URL,
        form,
        signatureHeader: sig,
      }),
    ).toBe(false);
  });

  it("rejects when signature header is null", () => {
    const form = { MessageSid: "SM1", From: "+1", To: "+1", Body: "hi" };
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        fullUrl: URL,
        form,
        signatureHeader: null,
      }),
    ).toBe(false);
  });

  it("is tolerant to form-key order (sorts alphabetically internally)", () => {
    const form = {
      Body: "hey",
      To: "+15558675309",
      From: "+18163706846",
      MessageSid: "SM2",
    };
    const sig = signFixture(form);
    // Re-order keys in the verify call — should still match because
    // the verifier sorts before concatenating.
    const reordered = {
      MessageSid: form.MessageSid,
      To: form.To,
      Body: form.Body,
      From: form.From,
    };
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        fullUrl: URL,
        form: reordered,
        signatureHeader: sig,
      }),
    ).toBe(true);
  });
});

describe("parseTwilioInbound", () => {
  it("extracts the typed subset from a form-encoded body", () => {
    const raw = new URLSearchParams({
      MessageSid: "SM_abc",
      From: "+18163706846",
      To: "+15558675309",
      Body: "hey there",
      AccountSid: "AC_xyz",
      NumMedia: "0",
    }).toString();
    const parsed = parseTwilioInbound(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.messageSid).toBe("SM_abc");
    expect(parsed!.from).toBe("+18163706846");
    expect(parsed!.to).toBe("+15558675309");
    expect(parsed!.body).toBe("hey there");
    expect(parsed!.form.AccountSid).toBe("AC_xyz");
  });

  it("falls back to SmsMessageSid when MessageSid is absent (legacy)", () => {
    const raw = new URLSearchParams({
      SmsMessageSid: "SM_legacy",
      From: "+1",
      To: "+1",
      Body: "hi",
    }).toString();
    const parsed = parseTwilioInbound(raw);
    expect(parsed!.messageSid).toBe("SM_legacy");
  });

  it("returns null when a required field is missing", () => {
    const raw = new URLSearchParams({
      MessageSid: "SM_incomplete",
      From: "+1",
      // To missing
      Body: "hi",
    }).toString();
    expect(parseTwilioInbound(raw)).toBeNull();
  });

  it("preserves empty-string body (valid use case for ACK messages)", () => {
    const raw = new URLSearchParams({
      MessageSid: "SM_empty",
      From: "+1",
      To: "+1",
      Body: "",
    }).toString();
    const parsed = parseTwilioInbound(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe("");
  });
});
