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

  it("emits the sole allowlisted payload key with a trimmed title", () => {
    expect(buildEsignMaterialEventPayload("  Purchase Agreement  ")).toEqual({
      template_title: "Purchase Agreement",
    });
  });

  it("enforces the 160 UTF-16 code-unit boundary without truncation", () => {
    expect(buildEsignMaterialEventPayload("a".repeat(160))).toEqual({
      template_title: "a".repeat(160),
    });
    expect(() => buildEsignMaterialEventPayload("a".repeat(161))).toThrow(
      "The eSign template title is invalid.",
    );
    expect(() => buildEsignMaterialEventPayload("😀".repeat(81))).toThrow(
      "The eSign template title is invalid.",
    );
  });

  it("does not invent a material presentation event for provider errors", () => {
    expect(materialEventTypeForStatus("error")).toBeNull();
  });
});
