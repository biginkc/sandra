import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ESIGN_TEMPLATE_MERGE_FIELDS,
  validateTemplateTitle,
  type DropboxSignProvider,
  type SendWithTemplateInput,
  type TemplateOption,
} from "./contracts";
import { getTemplateTitleValidationError } from "./template-contract";

describe("combined template and sending contract", () => {
  it("shares the normalized title and exact TemplateOption shape", () => {
    const normalizedTitle = validateTemplateTitle("  Offer  ");
    if (!normalizedTitle) throw new Error("expected a valid normalized title");
    const option = {
      id: "local-1",
      name: normalizedTitle,
      documentType: "Purchase agreement",
      providerTemplateId: "provider-1",
      sellerRoleName: "Seller",
      signerRoles: [{ name: "Seller", order: 0 }, { name: "seller", order: 1 }],
      mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS,
    } satisfies TemplateOption;

    expect(option.name).toBe("Offer");
    expect(option.signerRoles.map((role) => role.name)).toEqual(["Seller", "seller"]);
    expect(getTemplateTitleValidationError(option.name)).toBeNull();
  });

  it("keeps Session 03 cancellation inputs in the consolidated provider", () => {
    expectTypeOf<SendWithTemplateInput["signal"]>().toEqualTypeOf<AbortSignal | undefined>();
    expectTypeOf<DropboxSignProvider["cancel"]>().parameter(1).toEqualTypeOf<AbortSignal | undefined>();
    expectTypeOf<DropboxSignProvider["remind"]>().parameter(2).toEqualTypeOf<AbortSignal | undefined>();
  });
});
