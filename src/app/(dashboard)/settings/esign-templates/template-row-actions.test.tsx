import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DuplicateTemplateDialog, TemplateRowActions } from "./template-row-actions";
import type { EsignTemplateRow, TemplateLibraryActions } from "./types";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

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
  beginEditRevision: vi.fn(),
  checkEditorReadiness: vi.fn(),
  abandonDraft: vi.fn(),
  retryCleanup: vi.fn(),
  deleteTemplate: vi.fn(),
};

describe("DuplicateTemplateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("rejects an over-limit new name without calling the action", () => {
    render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.change(screen.getByLabelText("Copy name"), { target: { value: "😀".repeat(81) } });
    expect(screen.getByRole("alert")).toHaveTextContent("Template names must be 160 characters or fewer.");
    expect(screen.getByRole("button", { name: "Duplicate template" })).toBeDisabled();
    expect(actions.duplicateTemplate).not.toHaveBeenCalled();
  });

  it("uses the reference max-xl confirmation width", () => {
    render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-xl");
  });

  it("opens a ready copy immediately", async () => {
    vi.mocked(actions.duplicateTemplate).mockResolvedValue({ ok: true, data: { templateId: "copy-ready", readiness: "ready" } });
    render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate template" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/esign-templates/copy-ready/edit"));
    expect(actions.checkEditorReadiness).not.toHaveBeenCalled();
  });

  it("keeps a pending copy locked until a bounded readiness check succeeds", async () => {
    vi.useFakeTimers();
    vi.mocked(actions.duplicateTemplate).mockResolvedValue({ ok: true, data: { templateId: "copy-pending", readiness: "pending" } });
    vi.mocked(actions.checkEditorReadiness)
      .mockResolvedValueOnce({ ok: true, data: { readiness: "pending" } })
      .mockResolvedValueOnce({ ok: true, data: { readiness: "ready" } });
    render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate template" }));
    await act(async () => {});
    expect(screen.getByText("Copy is still preparing")).toBeVisible();
    expect(push).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(push).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(push).toHaveBeenCalledWith("/settings/esign-templates/copy-pending/edit");
  });

  it("stops automatic polling after three delayed checks and leaves Reload available", async () => {
    vi.useFakeTimers();
    vi.mocked(actions.duplicateTemplate).mockResolvedValue({ ok: true, data: { templateId: "copy-delayed", readiness: "pending" } });
    vi.mocked(actions.checkEditorReadiness).mockResolvedValue({ ok: true, data: { readiness: "pending" } });
    render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate template" }));
    await act(async () => {});
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    }
    expect(actions.checkEditorReadiness).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(actions.checkEditorReadiness).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Reload" })).toBeEnabled();
    expect(push).not.toHaveBeenCalled();
  });

  it("stops after a readiness error and exposes an explicit Reload path", async () => {
    vi.useFakeTimers();
    vi.mocked(actions.duplicateTemplate).mockResolvedValue({ ok: true, data: { templateId: "copy-error", readiness: "pending" } });
    vi.mocked(actions.checkEditorReadiness)
      .mockResolvedValueOnce({ ok: false, error: { code: "READINESS_FAILED", message: "Could not check the copy." } })
      .mockResolvedValueOnce({ ok: true, data: { readiness: "ready" } });
    render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate template" }));
    await act(async () => {});
    expect(screen.getByText("Copy is still preparing")).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not check the copy.");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload" })); });
    expect(push).toHaveBeenCalledWith("/settings/esign-templates/copy-error/edit");
  });

  it("single-flights an automatic check with Reload and routes once", async () => {
    vi.useFakeTimers();
    const ready = deferred<{ ok: true; data: { readiness: "ready" } }>();
    vi.mocked(actions.duplicateTemplate).mockResolvedValue({ ok: true, data: { templateId: "copy-race", readiness: "pending" } });
    vi.mocked(actions.checkEditorReadiness).mockReturnValue(ready.promise);
    render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate template" }));
    await act(async () => {});
    const reload = screen.getByRole("button", { name: "Reload" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(actions.checkEditorReadiness).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    fireEvent.click(reload);
    expect(actions.checkEditorReadiness).toHaveBeenCalledTimes(1);
    ready.resolve({ ok: true, data: { readiness: "ready" } });
    await act(async () => { await ready.promise; });
    expect(push).toHaveBeenCalledWith("/settings/esign-templates/copy-race/edit");
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not route when readiness resolves after the dialog unmounts", async () => {
    vi.useFakeTimers();
    const ready = deferred<{ ok: true; data: { readiness: "ready" } }>();
    vi.mocked(actions.duplicateTemplate).mockResolvedValue({ ok: true, data: { templateId: "copy-late", readiness: "pending" } });
    vi.mocked(actions.checkEditorReadiness).mockReturnValue(ready.promise);
    const view = render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate template" }));
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    view.unmount();
    ready.resolve({ ok: true, data: { readiness: "ready" } });
    await act(async () => { await ready.promise; });
    expect(push).not.toHaveBeenCalled();
  });
});

describe("versioned Edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("keeps a pending hidden revision off the editor route and refreshes recovery", async () => {
    vi.mocked(actions.beginEditRevision).mockResolvedValue({ ok: true, data: { templateId: "revision-pending", readiness: "pending" } });
    render(<TemplateRowActions template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(push).not.toHaveBeenCalled();
  });

  it("routes only the ready hidden revision into the editor", async () => {
    vi.mocked(actions.beginEditRevision).mockResolvedValue({ ok: true, data: { templateId: "revision-ready", readiness: "ready" } });
    render(<TemplateRowActions template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/esign-templates/revision-ready/edit"));
  });
});

describe("DeleteTemplateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("uses a max-xl dialog and destructive tint for recent sends", () => {
    render(<TemplateRowActions template={{ ...template, recentSendCount30d: 3 }} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-xl");
    expect(screen.getByText(/used for 3 contracts in the last 30 days/i)).toHaveClass(
      "border-destructive/20",
      "bg-destructive/10",
      "text-destructive",
    );
    expect(screen.getByRole("button", { name: "Delete template" })).toHaveClass(
      "bg-destructive/10",
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
