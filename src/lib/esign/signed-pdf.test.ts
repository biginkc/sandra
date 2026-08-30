import { describe, expect, it } from "vitest";

import {
  SignedPdfValidationError,
  buildSignedPdfArtifact,
  validateSignedPdf,
} from "./signed-pdf";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

function pdf(extra = "signed-content"): Buffer {
  return Buffer.from(`%PDF-1.7\n${extra}`, "ascii");
}

describe("signed PDF safety", () => {
  it("accepts a PDF header and builds an opaque ID-only private path", () => {
    expect(
      buildSignedPdfArtifact({
        orgId: ORG_ID.toUpperCase(),
        propertyId: PROPERTY_ID,
        requestId: REQUEST_ID,
        pdf: pdf(),
      }),
    ).toEqual({
      storageBucket: "lead-files",
      storagePath: `${ORG_ID}/${PROPERTY_ID}/esign/${REQUEST_ID}/signed.pdf`,
      fileName: "signed-contract-33333333.pdf",
      contentType: "application/pdf",
      sizeBytes: pdf().byteLength,
    });
  });

  it("accepts canonical database UUIDs without requiring a generated version", () => {
    const zeroVersionRequestId = "00000000-0000-0000-0000-000000000001";
    expect(
      buildSignedPdfArtifact({
        orgId: ORG_ID,
        propertyId: PROPERTY_ID,
        requestId: zeroVersionRequestId,
        pdf: pdf(),
      }).storagePath,
    ).toBe(`${ORG_ID}/${PROPERTY_ID}/esign/${zeroVersionRequestId}/signed.pdf`);
  });

  it("rejects empty, non-PDF, and oversized responses", () => {
    expect(() => validateSignedPdf(Buffer.alloc(0))).toThrow(
      expect.objectContaining({ code: "EMPTY_PDF" }),
    );
    expect(() => validateSignedPdf(Buffer.from("not a PDF"))).toThrow(
      expect.objectContaining({ code: "INVALID_PDF" }),
    );
    expect(() => validateSignedPdf(pdf("too-large"), 5)).toThrow(
      expect.objectContaining({ code: "PDF_TOO_LARGE" }),
    );
  });

  it("rejects path identifiers without echoing their contents", () => {
    const privateAddress = "123-private-street";
    let caught: unknown;
    try {
      buildSignedPdfArtifact({
        orgId: privateAddress,
        propertyId: PROPERTY_ID,
        requestId: REQUEST_ID,
        pdf: pdf(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SignedPdfValidationError);
    expect(caught).toMatchObject({ code: "INVALID_IDENTIFIER" });
    expect((caught as Error).message).not.toContain(privateAddress);
  });
});
