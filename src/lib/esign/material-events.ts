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
  // The value came from the canonical database request/template lookup and the
  // foundation RPC compares it exactly. Never normalize it here: current rows
  // are already normalized, while Session 03 validates historical malformed
  // values and renders its literal safe fallback without exposing them.
  return { template_title: templateTitle };
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
