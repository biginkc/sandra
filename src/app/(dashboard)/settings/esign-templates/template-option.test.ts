import { describe, expect, it } from "vitest";

import { ESIGN_MERGE_FIELD_NAMES } from "./types";
import { toTemplateOption } from "./template-option";

const base = {
  id: "local-1",
  name: "Purchase agreement",
  documentType: "Purchase agreement",
  expectedProviderTemplateId: "provider-1",
  sellerRoleName: "Seller",
  provider: {
    providerTemplateId: "provider-1",
    signerRoles: [
      { name: "Seller", order: 0 },
      { name: "Buyer", order: 1 },
    ],
    mergeFieldNames: [...ESIGN_MERGE_FIELD_NAMES],
  },
} as const;

describe("toTemplateOption", () => {
  it("preserves the provider's exact role order and case", () => {
    expect(toTemplateOption(base).signerRoles).toEqual([
      { name: "Seller", order: 0 },
      { name: "Buyer", order: 1 },
    ]);
  });

  it("rejects a case-changed seller mapping", () => {
    expect(() => toTemplateOption({ ...base, sellerRoleName: "seller" })).toThrow(
      /choose the seller role/i,
    );
  });

  it("rejects missing, extra, or case-changed merge labels", () => {
    for (const mergeFieldNames of [
      ESIGN_MERGE_FIELD_NAMES.slice(0, 4),
      [...ESIGN_MERGE_FIELD_NAMES, "extra"],
      ["Seller_name", ...ESIGN_MERGE_FIELD_NAMES.slice(1)],
    ]) {
      expect(() =>
        toTemplateOption({
          ...base,
          provider: { ...base.provider, mergeFieldNames },
        }),
      ).toThrow(/exactly Sandra's five/i);
    }
  });

  it("trims valid titles and rejects empty or over-limit reconciliation", () => {
    expect(toTemplateOption({ ...base, name: "  Offer  " }).name).toBe("Offer");
    expect(() => toTemplateOption({ ...base, name: "   " })).toThrow("Enter a template name.");
    expect(() => toTemplateOption({ ...base, name: "😀".repeat(81) })).toThrow(
      "Template names must be 160 characters or fewer.",
    );
  });
});
