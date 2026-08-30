import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DuplicateTemplateDialog } from "./template-row-actions";
import type { EsignTemplateRow, TemplateLibraryActions } from "./types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const template: EsignTemplateRow = {
  id: "local-1",
  name: "Offer",
  documentType: "Purchase agreement",
  providerTemplateId: "provider-1",
  signerRoles: [{ name: "Seller", order: 0 }],
  sellerRoleName: "Seller",
  mergeFieldNames: ["seller_name", "property_address", "offer_price", "closing_date", "earnest_money"],
  sourceFilename: "offer.pdf",
  sourceSizeBytes: 1024,
  pageCount: 1,
  fieldCount: 5,
  updatedAt: "2026-08-29T00:00:00Z",
  updatedByName: "Owner",
  recentSendCount30d: 0,
};

const actions: TemplateLibraryActions = {
  createDraft: vi.fn(),
  pickDropboxPdf: vi.fn(),
  duplicateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
};

describe("DuplicateTemplateDialog", () => {
  it("rejects an over-limit new name without calling the action", () => {
    render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.change(screen.getByLabelText("Copy name"), { target: { value: "😀".repeat(81) } });
    expect(screen.getByRole("alert")).toHaveTextContent("Template names must be 160 characters or fewer.");
    expect(screen.getByRole("button", { name: "Duplicate template" })).toBeDisabled();
    expect(actions.duplicateTemplate).not.toHaveBeenCalled();
  });
});
