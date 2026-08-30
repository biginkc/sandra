import { describe, expect, it } from "vitest";

import {
  ESIGN_TEMPLATE_TITLE_MAX_LENGTH,
  getTemplateTitleValidationError,
  requireTemplateTitle,
  validateTemplateTitle,
} from "./template-contract";

describe("template title contract", () => {
  it("trims a non-empty title without truncating it", () => {
    expect(requireTemplateTitle("  Purchase agreement  ")).toBe("Purchase agreement");
  });

  it("rejects empty and over-limit titles", () => {
    expect(validateTemplateTitle(" \n ")).toBeNull();
    expect(getTemplateTitleValidationError(" \n ")).toBe("Enter a template name.");
    expect(getTemplateTitleValidationError("a".repeat(ESIGN_TEMPLATE_TITLE_MAX_LENGTH + 1))).toBe(
      "Template names must be 160 characters or fewer.",
    );
  });

  it("measures the limit in UTF-16 code units", () => {
    expect("😀".repeat(80)).toHaveLength(160);
    expect(validateTemplateTitle("  " + "😀".repeat(80) + "  ")).toBe("😀".repeat(80));
    expect("😀".repeat(81)).toHaveLength(162);
    expect(validateTemplateTitle("😀".repeat(81))).toBeNull();
    expect(getTemplateTitleValidationError("😀".repeat(81))).toBe(
      "Template names must be 160 characters or fewer.",
    );
  });
});
