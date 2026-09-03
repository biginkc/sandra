import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  normalizeTemplateLayout,
  TemplateLayoutError,
  UnknownTemplateFieldTypeError,
} from "./template-layout";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/dropbox-sign-template-export.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

describe("normalizeTemplateLayout", () => {
  it("normalizes a realistic two-document template without losing coordinates", () => {
    expect(normalizeTemplateLayout(fixture)).toEqual({
      version: 1,
      signerRoles: [
        { name: "Seller", order: 0 },
        { name: "Buyer", order: 1 },
      ],
      mergeFieldNames: [
        "seller_name",
        "property_address",
        "offer_price",
        "closing_date",
        "earnest_money",
      ],
      documents: [
        {
          index: 0,
          name: "purchase-agreement.pdf",
          fields: [
            {
              apiId: "seller-signature",
              name: "Seller signature",
              type: "signature",
              signer: 0,
              page: 0,
              x: 72,
              y: 612,
              width: 180,
              height: 36,
              required: true,
            },
            {
              apiId: "seller-initials",
              name: "Seller initials",
              type: "initials",
              signer: 0,
              page: 1,
              x: 72,
              y: 96,
              width: 54,
              height: 30,
              required: true,
              group: "seller-initials",
            },
            {
              apiId: "merge-seller-name",
              name: "seller_name",
              type: "text",
              signer: "sender",
              page: 0,
              x: 72,
              y: 140,
              width: 240,
              height: 24,
              required: false,
            },
            {
              apiId: "merge-property-address",
              name: "property_address",
              type: "text",
              signer: "sender",
              page: 0,
              x: 72,
              y: 184,
              width: 360,
              height: 24,
              required: false,
            },
            {
              apiId: "merge-offer-price",
              name: "offer_price",
              type: "text",
              signer: "sender",
              page: 0,
              x: 72,
              y: 228,
              width: 160,
              height: 24,
              required: false,
            },
          ],
        },
        {
          index: 1,
          name: "disclosures.pdf",
          fields: [
            {
              apiId: "buyer-signature",
              name: "Buyer signature",
              type: "signature",
              signer: 1,
              page: 0,
              x: 72,
              y: 540,
              width: 180,
              height: 36,
              required: true,
            },
            {
              apiId: "buyer-approval",
              name: "Buyer approval",
              type: "checkbox",
              signer: 1,
              page: 0,
              x: 72,
              y: 480,
              width: 18,
              height: 18,
              required: true,
            },
            {
              apiId: "merge-closing-date",
              name: "closing_date",
              type: "text",
              signer: "sender",
              page: 0,
              x: 72,
              y: 160,
              width: 160,
              height: 24,
              required: false,
            },
            {
              apiId: "merge-earnest-money",
              name: "earnest_money",
              type: "text",
              signer: "sender",
              page: 0,
              x: 72,
              y: 204,
              width: 160,
              height: 24,
              required: false,
            },
          ],
        },
      ],
    });
  });

  it("accepts the camelCase SDK model as well as the HTTP response shape", () => {
    const camelCase = {
      signerRoles: fixture.signer_roles,
      customFields: fixture.custom_fields,
      documents: [
        {
          index: 0,
          name: "document.pdf",
          formFields: [{
            type: "signature",
            apiId: "signature",
            name: "Seller signature",
            signer: "Seller",
            x: 1,
            y: 2,
            width: 3,
            height: 4,
          }],
          customFields: [],
        },
      ],
    };
    expect(normalizeTemplateLayout(camelCase).documents[0].fields[0]).toMatchObject({
      apiId: "signature",
      signer: 0,
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it("maps Dropbox Sign's one-based numeric signer identifiers to zero-based role orders", () => {
    const normalized = normalizeTemplateLayout({
      signer_roles: [
        { name: "Seller", order: 0 },
        { name: "Buyer", order: 1 },
      ],
      documents: [{
        name: "document.pdf",
        form_fields: [
          {
            type: "signature",
            api_id: "seller-signature",
            name: "Seller signature",
            signer: "1",
            x: 1,
            y: 2,
            width: 3,
            height: 4,
          },
          {
            type: "signature",
            api_id: "buyer-signature",
            name: "Buyer signature",
            signer: "2",
            x: 5,
            y: 6,
            width: 7,
            height: 8,
          },
        ],
      }],
    });
    expect(normalized.documents[0].fields.map((field) => field.signer)).toEqual([
      0,
      1,
    ]);
  });

  it("rejects unsupported provider field types with a typed error", () => {
    const invalid = structuredClone(fixture) as {
      documents: Array<{ form_fields: Array<{ type: string }> }>;
    };
    invalid.documents[0].form_fields[0].type = "stamp";

    expect(() => normalizeTemplateLayout(invalid)).toThrow(
      UnknownTemplateFieldTypeError,
    );
    expect(() => normalizeTemplateLayout(invalid)).toThrowError(
      expect.objectContaining({
        code: "UNKNOWN_FIELD_TYPE",
        fieldType: "stamp",
      }),
    );
    expect(new UnknownTemplateFieldTypeError("stamp", "form")).toBeInstanceOf(
      TemplateLayoutError,
    );
  });
});
