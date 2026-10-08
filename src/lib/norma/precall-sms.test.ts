import { describe, expect, it, vi } from "vitest";

import type { SendSmsOutcome } from "@/lib/messaging/send";

import { NORMA_PRECALL_SMS_TEMPLATE, readPrecallSmsEnabled, renderPrecallSms, sendNormaPrecallSms } from "./precall-sms";
import { fakeClient, PHONE, REQUEST_ID } from "./test-helpers";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: vi.fn(async () => ({ status: "sent", messageId: "m", externalId: "e" })) }));

const NAMED =
  "Hi Sam, this is BMH Group. Norma from our team will call you in a minute from (816) 705-3501 about 1 Main St. Reply STOP to opt out.";
const BLANK =
  "Hi, this is BMH Group. Norma from our team will call you in a minute from (816) 705-3501 about 1 Main St. Reply STOP to opt out.";

describe("pre-call text template (approved verbatim)", () => {
  it("is exactly the approved string", () => {
    expect(NORMA_PRECALL_SMS_TEMPLATE).toBe(
      "Hi {first_name}, this is BMH Group. Norma from our team will call you in a minute from (816) 705-3501 about {address}. Reply STOP to opt out.",
    );
  });

  it("pins the rendered output with a first name", () => {
    expect(renderPrecallSms(NORMA_PRECALL_SMS_TEMPLATE, { firstName: "Sam", address: "1 Main St" })).toEqual({ ok: true, body: NAMED });
  });

  it("pins the rendered output with a blank name (name and its comma dropped, 'Hi,' kept)", () => {
    for (const firstName of [null, undefined, "", "   "]) {
      expect(renderPrecallSms(NORMA_PRECALL_SMS_TEMPLATE, { firstName, address: "1 Main St" })).toEqual({ ok: true, body: BLANK });
    }
  });

  it("a blank address renders nothing (the text is skipped, not sent with a hole)", () => {
    expect(renderPrecallSms(NORMA_PRECALL_SMS_TEMPLATE, { firstName: "Sam", address: " " })).toEqual({ ok: false, reason: "missing_address" });
  });

  it("only {first_name} and {address} are placeholders; anything else is left alone", () => {
    expect(renderPrecallSms("A {first_name} {address} {phone}", { firstName: "Sam", address: "X" })).toEqual({ ok: true, body: "A Sam X {phone}" });
  });

  it("an empty template renders nothing", () => {
    expect(renderPrecallSms("", { firstName: "Sam", address: "X" })).toEqual({ ok: false, reason: "empty_template" });
    expect(renderPrecallSms("  \n", { firstName: "Sam", address: "X" })).toEqual({ ok: false, reason: "empty_template" });
  });
});

describe("NORMA_PRECALL_SMS_ENABLED", () => {
  it("defaults to off", () => {
    expect(readPrecallSmsEnabled({})).toBe(false);
    expect(readPrecallSmsEnabled({ NORMA_PRECALL_SMS_ENABLED: "false" })).toBe(false);
    expect(readPrecallSmsEnabled({ NORMA_PRECALL_SMS_ENABLED: "true" })).toBe(true);
  });
});

const row = { id: REQUEST_ID, org_id: "org1", property_id: "p1", contact_id: "c1", phone_e164: PHONE };
function clientFor(first_name: string | null = "Sam", address: string | null = "1 Main St") {
  return fakeClient({ contacts: [{ id: "c1", first_name }], properties: [{ id: "p1", org_id: "org1", address }] }).client;
}

describe("sendNormaPrecallSms", () => {
  it("disabled (the default): sends nothing and reads nothing", async () => {
    const send = vi.fn();
    expect(await sendNormaPrecallSms(clientFor(), row, { enabled: false, send })).toEqual({ status: "disabled" });
    expect(send).not.toHaveBeenCalled();
  });

  it("enabled with an EMPTY template is a no-op", async () => {
    const send = vi.fn();
    expect(await sendNormaPrecallSms(clientFor(), row, { enabled: true, template: "", send })).toEqual({ status: "empty_template" });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the rendered text to the number about to be dialled, as an automated send through the SMS pipeline", async () => {
    const send = vi.fn(async (): Promise<SendSmsOutcome> => ({ status: "sent", messageId: "m1", externalId: "x1" }));
    expect(await sendNormaPrecallSms(clientFor(), row, { enabled: true, send })).toEqual({ status: "sent", detail: "sent" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "automated", contactId: "c1", propertyId: "p1", to: PHONE, body: NAMED }),
    );
  });

  it("a blank first name sends the 'Hi,' form", async () => {
    const send = vi.fn(async (): Promise<SendSmsOutcome> => ({ status: "sent", messageId: "m1", externalId: "x1" }));
    await sendNormaPrecallSms(clientFor("  "), row, { enabled: true, send });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ body: BLANK }));
  });

  it("a refusal (consent, DNC, quiet hours, landline...) is returned, not thrown", async () => {
    const send = vi.fn(async () => ({ status: "blocked_landline", reason: "landline" }) as SendSmsOutcome);
    expect(await sendNormaPrecallSms(clientFor(), row, { enabled: true, send })).toEqual({ status: "refused", detail: "blocked_landline" });
  });

  it("a consent-read failure is refused as consent_unavailable (no text, call still placed)", async () => {
    const send = vi.fn(async () => ({ status: "blocked_fresh_state_unavailable", error: "read failed" }) as SendSmsOutcome);
    expect(await sendNormaPrecallSms(clientFor(), row, { enabled: true, send })).toEqual({ status: "refused", detail: "consent_unavailable" });
  });

  it("a thrown error or a slow provider is a failure, never an exception and never a long wait", async () => {
    const boom = vi.fn(async () => {
      throw new Error("provider down");
    });
    expect(await sendNormaPrecallSms(clientFor(), row, { enabled: true, send: boom })).toEqual({ status: "failed", detail: "exception" });
    const slow = vi.fn(() => new Promise<SendSmsOutcome>(() => undefined));
    expect(await sendNormaPrecallSms(clientFor(), row, { enabled: true, send: slow, timeoutMs: 20 })).toEqual({ status: "failed", detail: "timeout" });
  });

  it("a missing address or contact skips the text", async () => {
    const send = vi.fn();
    expect(await sendNormaPrecallSms(clientFor("Sam", null), row, { enabled: true, send })).toEqual({ status: "skipped", detail: "missing_address" });
    expect(await sendNormaPrecallSms(clientFor(), { ...row, contact_id: null }, { enabled: true, send })).toEqual({ status: "skipped", detail: "no_contact" });
    expect(send).not.toHaveBeenCalled();
  });
});
