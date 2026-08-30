import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AddTemplateDialog } from "./add-template-dialog";
import { ESIGN_MERGE_FIELD_NAMES, type TemplateLibraryActions } from "./types";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

describe("AddTemplateDialog", () => {
  it("submits one PDF with exact roles and fixed merge labels", async () => {
    const createDraft = vi.fn().mockResolvedValue({ ok: true, data: { templateId: "local-1" } });
    const actions: TemplateLibraryActions = {
      createDraft,
      pickDropboxPdf: vi.fn(),
      duplicateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
    };
    render(<AddTemplateDialog actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Offer" } });
    const file = new File(["%PDF-1.7"], "offer.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Upload PDF"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and place fields" }));

    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Offer",
        signerRoles: [{ name: "Seller", order: 0 }],
        sellerRoleName: "Seller",
        mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
      }),
    );
    expect(push).toHaveBeenCalledWith("/settings/esign-templates/local-1/edit");
  });

  it("rejects files larger than 40 MB before calling the adapter", () => {
    const actions: TemplateLibraryActions = {
      createDraft: vi.fn(),
      pickDropboxPdf: vi.fn(),
      duplicateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
    };
    render(<AddTemplateDialog actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));
    const file = new File(["x"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 40 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("Upload PDF"), { target: { files: [file] } });
    expect(screen.getByRole("alert")).toHaveTextContent("smaller than 40 MB");
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("accepts 80 emoji but rejects 81 using the UTF-16 title limit", () => {
    const actions: TemplateLibraryActions = {
      createDraft: vi.fn(),
      pickDropboxPdf: vi.fn(),
      duplicateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
    };
    render(<AddTemplateDialog actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));
    const name = screen.getByLabelText("Template name");
    fireEvent.change(name, { target: { value: "😀".repeat(80) } });
    expect(screen.queryByText("Template names must be 160 characters or fewer.")).not.toBeInTheDocument();
    fireEvent.change(name, { target: { value: "😀".repeat(81) } });
    expect(screen.getByRole("alert")).toHaveTextContent("Template names must be 160 characters or fewer.");
  });
});
