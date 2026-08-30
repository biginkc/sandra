import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ESIGN_MERGE_FIELD_NAMES, type EsignTemplateRow } from "./types";
import { TemplateLibrary } from "./template-library";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const row: EsignTemplateRow = {
  id: "template-1",
  name: "Missouri purchase agreement",
  documentType: "Purchase agreement",
  providerTemplateId: "provider-1",
  signerRoles: [
    { name: "Buyer", order: 1 },
    { name: "Seller", order: 0 },
  ],
  sellerRoleName: "Seller",
  mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
  sourceFilename: "purchase-agreement.pdf",
  sourceSizeBytes: 2_400_000,
  pageCount: 8,
  fieldCount: 14,
  updatedAt: "2026-08-29T12:00:00.000Z",
  updatedByName: "Jarrad Henry",
  recentSendCount30d: 2,
};

describe("TemplateLibrary", () => {
  it("renders an explicit load failure instead of an empty table", () => {
    render(
      <TemplateLibrary
        result={{ ok: false, error: { code: "DB_DOWN", message: "Database unavailable" } }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Database unavailable");
    expect(screen.getByText("DB_DOWN")).toBeVisible();
  });

  it("renders the dedicated empty state", () => {
    render(<TemplateLibrary result={{ ok: true, data: [] }} />);
    expect(screen.getByText("No eSign templates yet")).toBeVisible();
  });

  it("sorts provider roles by order and warns before deleting recent usage", () => {
    render(<TemplateLibrary result={{ ok: true, data: [row] }} />);
    const list = screen.getByRole("list", {
      name: "Required signer roles for Missouri purchase agreement",
    });
    expect(list).toHaveTextContent("1.Seller(seller)2.Buyer");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/used for 2 contracts in the last 30 days/i)).toBeVisible();
    expect(screen.getByText(/existing contract records and saved PDFs stay/i)).toBeVisible();
  });
});
