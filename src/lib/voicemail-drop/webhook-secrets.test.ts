import { describe, expect, it } from "vitest";

import { selectDropCowboyWebhookSecret } from "./webhook";

const env = { DROPCOWBOY_WEBHOOK_SECRET: "status-secret", DROPCOWBOY_RECEIPT_WEBHOOK_SECRET: "receipt-secret", DROPCOWBOY_CALL_WEBHOOK_SECRET: "call-secret" };
const body = (event: unknown) => JSON.stringify({ event, event_id: "e", data: {} });

describe("selectDropCowboyWebhookSecret", () => {
  it("uses the status secret for contact.rvm.status", () => {
    expect(selectDropCowboyWebhookSecret(body("contact.rvm.status"), env)).toEqual({
      kind: "supported", event: "contact.rvm.status", envName: "DROPCOWBOY_WEBHOOK_SECRET", secret: "status-secret",
    });
  });

  it("uses the receipt secret for contact.rvm.receipt", () => {
    expect(selectDropCowboyWebhookSecret(body("contact.rvm.receipt"), env)).toEqual({
      kind: "supported", event: "contact.rvm.receipt", envName: "DROPCOWBOY_RECEIPT_WEBHOOK_SECRET", secret: "receipt-secret",
    });
  });

  it("uses the call secret for contact.call.ringing and never another event's", () => {
    expect(selectDropCowboyWebhookSecret(body("contact.call.ringing"), env)).toEqual({
      kind: "supported", event: "contact.call.ringing", envName: "DROPCOWBOY_CALL_WEBHOOK_SECRET", secret: "call-secret",
    });
    expect(selectDropCowboyWebhookSecret(body("contact.call.ringing"), { DROPCOWBOY_WEBHOOK_SECRET: "s", DROPCOWBOY_RECEIPT_WEBHOOK_SECRET: "r" }))
      .toMatchObject({ kind: "supported", secret: null });
  });

  it("never falls back to the other event's secret when one is unset", () => {
    expect(selectDropCowboyWebhookSecret(body("contact.rvm.receipt"), { DROPCOWBOY_WEBHOOK_SECRET: "status-secret" }))
      .toMatchObject({ kind: "supported", secret: null });
    expect(selectDropCowboyWebhookSecret(body("contact.rvm.status"), { DROPCOWBOY_RECEIPT_WEBHOOK_SECRET: "receipt-secret", DROPCOWBOY_WEBHOOK_SECRET: "" }))
      .toMatchObject({ kind: "supported", secret: null });
  });

  it("marks unknown events unsupported, including prototype keys", () => {
    expect(selectDropCowboyWebhookSecret(body("contact.sms.status"), env)).toEqual({ kind: "unsupported", event: "contact.sms.status" });
    expect(selectDropCowboyWebhookSecret(body("toString"), env)).toEqual({ kind: "unsupported", event: "toString" });
  });

  it("marks non-JSON, non-object and event-less bodies unparseable", () => {
    for (const raw of ["nope", "[]", "null", JSON.stringify({ event: 7 }), "{}"]) {
      expect(selectDropCowboyWebhookSecret(raw, env)).toEqual({ kind: "unparseable" });
    }
  });
});
