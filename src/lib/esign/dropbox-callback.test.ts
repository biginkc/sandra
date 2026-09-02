import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DropboxCallbackValidationError,
  buildDropboxSignReceiptFingerprint,
  parseDropboxSignCallbackFormData,
  verifyDropboxSignEventHash,
  type DropboxSignReplayData,
} from "./dropbox-callback";

const API_KEY = "dropbox-test-api-key";

function replay(overrides: Partial<DropboxSignReplayData> = {}): DropboxSignReplayData {
  const eventTime = overrides.eventTime ?? "1788054000";
  const eventType = overrides.eventType ?? "signature_request_viewed";
  return {
    payloadHash: "f".repeat(64),
    eventTime,
    eventType,
    eventHash:
      overrides.eventHash ??
      createHmac("sha256", API_KEY).update(eventTime + eventType).digest("hex"),
    signRequestId: overrides.signRequestId ?? "request-1",
    localRequestId: overrides.localRequestId ?? "local-request-1",
    relatedSignatureId: overrides.relatedSignatureId ?? "signature-1",
    reportedForAppId: overrides.reportedForAppId ?? "app-1",
    providerSignatures: overrides.providerSignatures ?? [],
  };
}

function callbackForm(event: DropboxSignReplayData): FormData {
  const form = new FormData();
  form.set(
    "json",
    JSON.stringify({
      event: {
        event_time: event.eventTime,
        event_type: event.eventType,
        event_hash: event.eventHash,
        event_metadata: {
          related_signature_id: event.relatedSignatureId,
          reported_for_app_id: event.reportedForAppId,
        },
      },
      signature_request: {
        signature_request_id: event.signRequestId,
        metadata: { sandra_request_id: event.localRequestId },
        signatures: event.providerSignatures.map((signature) => ({
          signature_id: signature.signatureId,
          signer_role: signature.role,
          signer_name: signature.name,
          signer_email_address: signature.emailAddress,
          order: signature.order,
          status_code: signature.statusCode,
          signed_at: signature.signedAt,
        })),
      },
    }),
  );
  return form;
}

describe("Dropbox Sign callback parsing and authenticity", () => {
  it("parses the multipart json field into PII-minimal replay data", () => {
    const event = replay({
      providerSignatures: [{
        signatureId: "signature-1",
        role: "Seller",
        name: "Private Seller",
        emailAddress: "seller@example.com",
        order: 0,
        statusCode: "signed",
        signedAt: 1788054010,
      }],
    });
    const parsed = parseDropboxSignCallbackFormData(callbackForm(event));
    expect(parsed).toEqual({ ...event, payloadHash: parsed.payloadHash });
    expect(parsed.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(buildDropboxSignReceiptFingerprint(parsed)).not.toContain(
      "seller@example.com",
    );
  });

  it("verifies the documented HMAC input and rejects an invalid hash", () => {
    const event = replay();
    expect(verifyDropboxSignEventHash(event, API_KEY)).toBe(true);
    expect(
      verifyDropboxSignEventHash({ ...event, eventHash: "0".repeat(64) }, API_KEY),
    ).toBe(false);
    expect(
      verifyDropboxSignEventHash({ ...event, eventHash: "not-hex" }, API_KEY),
    ).toBe(false);
  });

  it("keeps same-second events distinct across request and signer identity", () => {
    const first = replay();
    const otherRequest = replay({ signRequestId: "request-2" });
    const otherLocalRequest = replay({ localRequestId: "local-request-2" });
    const otherSigner = replay({ relatedSignatureId: "signature-2" });

    expect(first.eventHash).toBe(otherRequest.eventHash);
    expect(buildDropboxSignReceiptFingerprint(first)).not.toBe(
      buildDropboxSignReceiptFingerprint(otherRequest),
    );
    expect(buildDropboxSignReceiptFingerprint(first)).not.toBe(
      buildDropboxSignReceiptFingerprint(otherLocalRequest),
    );
    expect(buildDropboxSignReceiptFingerprint(first)).not.toBe(
      buildDropboxSignReceiptFingerprint(otherSigner),
    );
    expect(buildDropboxSignReceiptFingerprint(first)).toBe(
      buildDropboxSignReceiptFingerprint({ ...first }),
    );
  });

  it("rejects duplicate json fields without echoing signer PII", () => {
    const sellerEmail = "private-seller@example.com";
    const form = callbackForm(replay());
    form.append("json", JSON.stringify({ seller_email: sellerEmail }));

    let caught: unknown;
    try {
      parseDropboxSignCallbackFormData(form);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DropboxCallbackValidationError);
    expect((caught as Error).message).not.toContain(sellerEmail);
  });

  it("uses a PII-safe validation error for malformed event data", () => {
    const sellerEmail = "private-seller@example.com";
    const form = new FormData();
    form.set(
      "json",
      JSON.stringify({
        event: { event_type: sellerEmail },
        signature_request: { signatures: [{ signer_email_address: sellerEmail }] },
      }),
    );

    expect(() => parseDropboxSignCallbackFormData(form)).toThrow(
      "Dropbox Sign callback event is invalid.",
    );
    try {
      parseDropboxSignCallbackFormData(form);
    } catch (error) {
      expect((error as Error).message).not.toContain(sellerEmail);
    }
  });
});
