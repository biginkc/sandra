import type { EsignStatus } from "./status";

export const ESIGN_MATERIAL_EVENT_TYPES = {
  AWAITING: "esign_awaiting",
  VIEWED: "esign_viewed",
  SIGNED: "esign_signed",
  DECLINED: "esign_declined",
  VOIDED: "esign_voided",
  SIGNED_PDF_READY: "esign_signed_pdf_ready",
} as const;

export type EsignMaterialEventType =
  (typeof ESIGN_MATERIAL_EVENT_TYPES)[keyof typeof ESIGN_MATERIAL_EVENT_TYPES];

export type EsignMaterialEventPayload = { template_title: string };

export const MAX_ESIGN_TEMPLATE_TITLE_CODE_UNITS = 160;

export function buildEsignMaterialEventPayload(
  templateTitle: string,
): EsignMaterialEventPayload {
  const title = templateTitle.trim();
  if (title.length < 1 || title.length > MAX_ESIGN_TEMPLATE_TITLE_CODE_UNITS) {
    throw new EsignMaterialEventValidationError();
  }
  return { template_title: title };
}

export function materialEventTypeForStatus(
  status: EsignStatus,
): Exclude<EsignMaterialEventType, "esign_signed_pdf_ready"> | null {
  switch (status) {
    case "awaiting":
      return ESIGN_MATERIAL_EVENT_TYPES.AWAITING;
    case "viewed":
      return ESIGN_MATERIAL_EVENT_TYPES.VIEWED;
    case "signed":
      return ESIGN_MATERIAL_EVENT_TYPES.SIGNED;
    case "declined":
      return ESIGN_MATERIAL_EVENT_TYPES.DECLINED;
    case "voided":
      return ESIGN_MATERIAL_EVENT_TYPES.VOIDED;
    case "error":
      return null;
  }
}

export class EsignMaterialEventValidationError extends Error {
  readonly code = "INVALID_TEMPLATE_TITLE";

  constructor() {
    super("The eSign template title is invalid.");
    this.name = "EsignMaterialEventValidationError";
  }
}
