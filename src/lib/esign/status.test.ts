import { describe, expect, it } from "vitest";

import {
  normalizeDropboxSignLifecycleEvent,
  reduceEsignStatus,
  type EsignStatus,
} from "./status";

function apply(current: EsignStatus, eventType: string) {
  return reduceEsignStatus(current, normalizeDropboxSignLifecycleEvent(eventType));
}

describe("Dropbox Sign lifecycle normalization", () => {
  it("keeps per-signer signed events nonterminal", () => {
    expect(apply("awaiting", "signature_request_signed")).toMatchObject({
      nextStatus: "awaiting",
      changed: false,
      reason: "audit_only",
    });
    expect(apply("viewed", "signature_request_signed")).toMatchObject({
      nextStatus: "viewed",
      changed: false,
    });
  });

  it("marks signed only from all-signed or downloadable completion semantics", () => {
    expect(apply("viewed", "signature_request_all_signed")).toMatchObject({
      nextStatus: "signed",
      changed: true,
      artifactReady: false,
    });
    expect(apply("awaiting", "signature_request_downloadable")).toMatchObject({
      nextStatus: "signed",
      changed: true,
      artifactReady: true,
    });
  });

  it("prevents out-of-order events from regressing terminal states", () => {
    expect(apply("signed", "signature_request_viewed")).toMatchObject({
      nextStatus: "signed",
      changed: false,
      reason: "terminal_sticky",
    });
    expect(apply("declined", "signature_request_all_signed")).toMatchObject({
      nextStatus: "declined",
      changed: false,
      reason: "terminal_sticky",
    });
    expect(apply("voided", "signature_request_email_bounce")).toMatchObject({
      nextStatus: "voided",
      changed: false,
      reason: "terminal_sticky",
    });
  });

  it("preserves the downloadable artifact signal after Signed", () => {
    expect(apply("signed", "signature_request_downloadable")).toMatchObject({
      nextStatus: "signed",
      changed: false,
      artifactReady: true,
      reason: "downloadable",
    });
  });

  it.each([
    ["signature_request_viewed", "viewed"],
    ["signature_request_declined", "declined"],
    ["signature_request_canceled", "voided"],
    ["signature_request_invalid", "error"],
    ["signature_request_expired", "error"],
    ["signature_request_email_bounce", "error"],
  ] as const)("maps %s to %s", (eventType, expected) => {
    expect(apply("awaiting", eventType).nextStatus).toBe(expected);
  });

  it("separates bounced-email evidence from generic provider errors", () => {
    expect(
      normalizeDropboxSignLifecycleEvent("signature_request_email_bounce"),
    ).toMatchObject({
      requestedStatus: "error",
      reason: "email_bounced",
    });
    expect(
      normalizeDropboxSignLifecycleEvent("signature_request_invalid"),
    ).toMatchObject({
      requestedStatus: "error",
      reason: "provider_error",
    });
  });
});
