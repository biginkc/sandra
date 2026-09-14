import { describe, expect, it } from "vitest";

import { buildEsignInvitation } from "./invitation";

describe("BMH signature invitation", () => {
  it("brands live requests and explains when the completed copy arrives", () => {
    expect(buildEsignInvitation({
      propertyAddress: "123 Main St",
      createdByLabel: "Maria Unkovich",
      testMode: false,
    })).toEqual({
      subject: "BMH Group | Purchase agreement for 123 Main St",
      message: "Prepared by Maria Unkovich for BMH Group.\n\nPlease review your purchase agreement and follow the prompts to complete your signature fields.\n\nOnce everyone has signed, Dropbox Sign will email you a copy of the completed agreement.\n\nIf you have questions before signing, email acquisitions@bmhgroupkc.com.\n\nThank you,\nBMH Group",
    });
  });

  it("keeps test requests unmistakable and handles missing display values", () => {
    const invitation = buildEsignInvitation({ propertyAddress: " ", testMode: true });
    expect(invitation.subject).toBe("TEST | BMH Group | Purchase agreement");
    expect(invitation.message).toMatch(/^INTERNAL TEST\. This request is not legally binding\./);
    expect(invitation.message).toContain("Prepared by the BMH Group acquisitions team.");
  });

  it("removes prohibited punctuation and subject line breaks only from email presentation", () => {
    const input = Object.freeze({
      propertyAddress: "123 Main St; Unit 2 — Kansas City\r\nMO",
      createdByLabel: "Maria — Acquisitions; BMH",
      testMode: false,
    });
    const invitation = buildEsignInvitation(input);
    expect(invitation.subject).toBe("BMH Group | Purchase agreement for 123 Main St, Unit 2, Kansas City MO");
    expect(invitation.subject + invitation.message).not.toMatch(/[—;]/);
    expect(input.propertyAddress).toContain("; Unit 2 —");
  });

  it("caps long subjects without dropping the brand or test marker", () => {
    const invitation = buildEsignInvitation({ propertyAddress: "A".repeat(300), testMode: true });
    expect(invitation.subject).toHaveLength(255);
    expect(invitation.subject).toMatch(/^TEST \| BMH Group \| Purchase agreement for /);
  });
});
