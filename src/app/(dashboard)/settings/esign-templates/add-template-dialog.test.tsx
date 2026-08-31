import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AddTemplateDialog } from "./add-template-dialog";
import { ESIGN_MERGE_FIELD_NAMES, type TemplateLibraryActions } from "./types";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

describe("AddTemplateDialog", () => {
  it("exposes an accessible max-xl PDF drop surface with browse and Dropbox choices", () => {
    render(<AddTemplateDialog actions={makeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));

    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-xl");
    const source = screen.getByRole("group", { name: "PDF source" });
    expect(source).toHaveClass("border-dashed");
    expect(source).toHaveTextContent("PDF only · up to 40 MB");
    expect(screen.getByRole("button", { name: "Browse" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Choose from Dropbox" })).toBeVisible();
  });

  it("accepts one dropped PDF and rejects multiple dropped files", () => {
    render(<AddTemplateDialog actions={makeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));
    const source = screen.getByRole("group", { name: "PDF source" });
    const offer = new File(["%PDF-1.7"], "offer.pdf", { type: "application/pdf" });

    fireEvent.drop(source, { dataTransfer: { files: [offer] } });
    expect(screen.getByText(/offer\.pdf.*Uploaded/)).toBeVisible();

    fireEvent.drop(source, {
      dataTransfer: {
        files: [offer, new File(["%PDF-1.7"], "second.pdf", { type: "application/pdf" })],
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose one PDF file.");
  });

  it("accepts an uploaded PDF exactly 40 MiB and rejects one byte over", () => {
    render(<AddTemplateDialog actions={makeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));
    const input = screen.getByLabelText("Upload PDF");
    const exact = sizedPdf("exact.pdf", 40 * 1024 * 1024);

    fireEvent.change(input, { target: { files: [exact] } });
    expect(screen.getByText(/exact\.pdf.*40\.0 MB.*Uploaded/)).toBeVisible();
    expect(screen.queryByText("The PDF must be 40 MB or smaller.")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { files: [sizedPdf("over.pdf", 40 * 1024 * 1024 + 1)] } });
    expect(screen.getByRole("alert")).toHaveTextContent("The PDF must be 40 MB or smaller.");
  });

  it("accepts a dropped PDF exactly 40 MiB and rejects one byte over", () => {
    render(<AddTemplateDialog actions={makeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));
    const source = screen.getByRole("group", { name: "PDF source" });

    fireEvent.drop(source, { dataTransfer: { files: [sizedPdf("exact-drop.pdf", 40 * 1024 * 1024)] } });
    expect(screen.getByText(/exact-drop\.pdf.*40\.0 MB.*Uploaded/)).toBeVisible();

    fireEvent.drop(source, { dataTransfer: { files: [sizedPdf("over-drop.pdf", 40 * 1024 * 1024 + 1)] } });
    expect(screen.getByRole("alert")).toHaveTextContent("The PDF must be 40 MB or smaller.");
  });

  it("submits one PDF with exact roles and fixed merge labels", async () => {
    const createDraft = vi.fn().mockResolvedValue({ ok: true, data: { templateId: "local-1" } });
    const actions: TemplateLibraryActions = {
      createDraft,
      pickDropboxPdf: vi.fn(),
      duplicateTemplate: vi.fn(),
      beginEditRevision: vi.fn(),
      checkEditorReadiness: vi.fn(),
      abandonDraft: vi.fn(),
      retryCleanup: vi.fn(),
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
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        stagingSourceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
    expect(push).toHaveBeenCalledWith("/settings/esign-templates/local-1/edit");
  });

  it("aborts the active upload attempt when the dialog is canceled", async () => {
    const createDraft = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const actions = makeActions({ createDraft });
    render(<AddTemplateDialog actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Offer" } });
    fireEvent.change(screen.getByLabelText("Upload PDF"), {
      target: { files: [new File(["%PDF-1.7"], "offer.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload and place fields" }));
    await waitFor(() => expect(createDraft).toHaveBeenCalledOnce());
    const signal = createDraft.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signal.aborted).toBe(true);
  });

  it("rejects files larger than 40 MB before calling the adapter", () => {
    const actions: TemplateLibraryActions = {
      createDraft: vi.fn(),
      pickDropboxPdf: vi.fn(),
      duplicateTemplate: vi.fn(),
      beginEditRevision: vi.fn(),
      checkEditorReadiness: vi.fn(),
      abandonDraft: vi.fn(),
      retryCleanup: vi.fn(),
      deleteTemplate: vi.fn(),
    };
    render(<AddTemplateDialog actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));
    const file = new File(["x"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 40 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("Upload PDF"), { target: { files: [file] } });
    expect(screen.getByRole("alert")).toHaveTextContent("40 MB or smaller");
    expect(actions.createDraft).not.toHaveBeenCalled();
  });

  it("accepts 80 emoji but rejects 81 using the UTF-16 title limit", () => {
    const actions: TemplateLibraryActions = {
      createDraft: vi.fn(),
      pickDropboxPdf: vi.fn(),
      duplicateTemplate: vi.fn(),
      beginEditRevision: vi.fn(),
      checkEditorReadiness: vi.fn(),
      abandonDraft: vi.fn(),
      retryCleanup: vi.fn(),
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

  it("allows exact case-distinct roles and rejects only exact trimmed duplicates", async () => {
    const createDraft = vi.fn().mockResolvedValue({ ok: true, data: { templateId: "local-1" } });
    const actions: TemplateLibraryActions = {
      createDraft,
      pickDropboxPdf: vi.fn(),
      duplicateTemplate: vi.fn(),
      beginEditRevision: vi.fn(),
      checkEditorReadiness: vi.fn(),
      abandonDraft: vi.fn(),
      retryCleanup: vi.fn(),
      deleteTemplate: vi.fn(),
    };
    render(<AddTemplateDialog actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Add template" }));
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Offer" } });
    fireEvent.change(screen.getByLabelText("Upload PDF"), { target: { files: [new File(["%PDF-1.7"], "offer.pdf", { type: "application/pdf" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    fireEvent.change(screen.getByLabelText("Signer role 2"), { target: { value: " Seller " } });
    expect(screen.getByRole("alert")).toHaveTextContent("Signer role names must be unique");
    fireEvent.change(screen.getByLabelText("Signer role 2"), { target: { value: "seller" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and place fields" }));
    await waitFor(() => expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        signerRoles: [{ name: "Seller", order: 0 }, { name: "seller", order: 1 }],
        sellerRoleName: "Seller",
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        stagingSourceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    ));
  });
});

function makeActions(overrides: Partial<TemplateLibraryActions> = {}): TemplateLibraryActions {
  return {
    createDraft: vi.fn(),
    pickDropboxPdf: vi.fn(),
    duplicateTemplate: vi.fn(),
    beginEditRevision: vi.fn(),
    checkEditorReadiness: vi.fn(),
    abandonDraft: vi.fn(),
    retryCleanup: vi.fn(),
    deleteTemplate: vi.fn(),
    ...overrides,
  };
}

function sizedPdf(name: string, size: number): File {
  const file = new File(["%PDF-1.7"], name, { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}
