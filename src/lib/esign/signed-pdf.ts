const PDF_MAGIC = Buffer.from("%PDF-", "ascii");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SIGNED_PDF_CONTENT_TYPE = "application/pdf";
export const DEFAULT_SIGNED_PDF_MAX_BYTES = 25 * 1024 * 1024;

export type SignedPdfValidationCode =
  | "EMPTY_PDF"
  | "PDF_TOO_LARGE"
  | "INVALID_PDF"
  | "INVALID_IDENTIFIER"
  | "INVALID_SIZE_LIMIT";

const SAFE_PDF_MESSAGES: Record<SignedPdfValidationCode, string> = {
  EMPTY_PDF: "Dropbox Sign returned an empty signed document.",
  PDF_TOO_LARGE: "The signed document exceeds the allowed size.",
  INVALID_PDF: "Dropbox Sign returned an invalid signed document.",
  INVALID_IDENTIFIER: "The signed document path is invalid.",
  INVALID_SIZE_LIMIT: "Signed document validation is misconfigured.",
};

export class SignedPdfValidationError extends Error {
  constructor(public readonly code: SignedPdfValidationCode) {
    super(SAFE_PDF_MESSAGES[code]);
    this.name = "SignedPdfValidationError";
  }
}

export type SignedPdfArtifact = {
  storageBucket: "lead-files";
  storagePath: string;
  fileName: string;
  contentType: typeof SIGNED_PDF_CONTENT_TYPE;
  sizeBytes: number;
};

export function validateSignedPdf(
  pdf: Uint8Array,
  maxBytes = DEFAULT_SIGNED_PDF_MAX_BYTES,
): { sizeBytes: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new SignedPdfValidationError("INVALID_SIZE_LIMIT");
  }
  if (pdf.byteLength === 0) {
    throw new SignedPdfValidationError("EMPTY_PDF");
  }
  if (pdf.byteLength > maxBytes) {
    throw new SignedPdfValidationError("PDF_TOO_LARGE");
  }
  if (
    pdf.byteLength < PDF_MAGIC.byteLength ||
    !Buffer.from(pdf.subarray(0, PDF_MAGIC.byteLength)).equals(PDF_MAGIC)
  ) {
    throw new SignedPdfValidationError("INVALID_PDF");
  }
  return { sizeBytes: pdf.byteLength };
}

export function buildSignedPdfArtifact(input: {
  orgId: string;
  propertyId: string;
  requestId: string;
  pdf: Uint8Array;
  maxBytes?: number;
}): SignedPdfArtifact {
  const orgId = normalizedUuid(input.orgId);
  const propertyId = normalizedUuid(input.propertyId);
  const requestId = normalizedUuid(input.requestId);
  const { sizeBytes } = validateSignedPdf(input.pdf, input.maxBytes);

  return {
    storageBucket: "lead-files",
    storagePath: `${orgId}/${propertyId}/esign/${requestId}/signed.pdf`,
    fileName: `signed-contract-${requestId.slice(0, 8)}.pdf`,
    contentType: SIGNED_PDF_CONTENT_TYPE,
    sizeBytes,
  };
}

function normalizedUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new SignedPdfValidationError("INVALID_IDENTIFIER");
  }
  return value.toLowerCase();
}
