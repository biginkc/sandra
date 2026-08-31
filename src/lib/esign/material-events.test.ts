import { describe, expect, it } from "vitest";

import {
  buildEsignMaterialEventPayload,
  ESIGN_MATERIAL_EVENT_TYPES,
  materialEventTypeForStatus,
} from "./material-events";

describe("eSign material lead-event contract", () => {
  it("locks the six presentation event names", () => {
    expect(Object.values(ESIGN_MATERIAL_EVENT_TYPES)).toEqual([
      "esign_awaiting",
      "esign_viewed",
      "esign_signed",
      "esign_declined",
      "esign_voided",
      "esign_signed_pdf_ready",
    ]);
  });

  it("emits the sole allowlisted payload key with the exact canonical title", () => {
    expect(buildEsignMaterialEventPayload("  Purchase Agreement  ")).toEqual({
      template_title: "  Purchase Agreement  ",
    });
  });

  it("preserves malformed historical titles for safe presentation fallback without truncation", () => {
    expect(buildEsignMaterialEventPayload("a".repeat(160))).toEqual({
      template_title: "a".repeat(160),
    });
    expect(buildEsignMaterialEventPayload("a".repeat(161))).toEqual({
      template_title: "a".repeat(161),
    });
    expect(buildEsignMaterialEventPayload("😀".repeat(81))).toEqual({
      template_title: "😀".repeat(81),
    });
    expect(buildEsignMaterialEventPayload("   ")).toEqual({ template_title: "   " });
    const wrapped = ` ${"a".repeat(159)} `;
    expect(wrapped.length).toBe(161);
    expect(buildEsignMaterialEventPayload(wrapped)).toEqual({ template_title: wrapped });
  });

  it("does not invent a material presentation event for provider errors", () => {
    expect(materialEventTypeForStatus("error")).toBeNull();
  });
});
