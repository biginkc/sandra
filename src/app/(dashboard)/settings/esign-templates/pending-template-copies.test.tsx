import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DuplicateTemplateDialog } from "./template-row-actions";
import { PendingTemplateCopies } from "./pending-template-copies";
import type { EsignTemplateRow, TemplateLibraryActions } from "./types";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const template: EsignTemplateRow = {
  id: "source-1",
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

function makeActions(): TemplateLibraryActions {
  return {
    createDraft: vi.fn(),
    pickDropboxPdf: vi.fn(),
    duplicateTemplate: vi.fn().mockResolvedValue({ ok: true, data: { templateId: "pending-1", readiness: "pending" } }),
    checkEditorReadiness: vi.fn().mockResolvedValue({ ok: true, data: { readiness: "pending" } }),
    abandonDraft: vi.fn().mockResolvedValue({ ok: true, data: null }),
    retryCleanup: vi.fn().mockResolvedValue({ ok: true, data: null }),
    deleteTemplate: vi.fn(),
  };
}

const pendingResult = {
  ok: true,
  data: [{ id: "pending-1", name: "Offer (copy)", lifecycle: "editing" }],
} as const;

describe("PendingTemplateCopies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("surfaces a pending-copy read failure instead of pretending there are no recoverable copies", () => {
    render(<PendingTemplateCopies result={{ ok: false, error: { code: "PENDING_COPY_LIST_FAILED", message: "Pending template copies could not be loaded." } }} actions={makeActions()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Pending copies could not be loaded");
    expect(screen.getByRole("alert")).toHaveTextContent("Reload this page before creating another copy");
  });

  it("rediscovers the same server-backed pending ID after the duplicate dialog closes and unmounts", async () => {
    const actions = makeActions();
    const dialog = render(<DuplicateTemplateDialog template={template} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate template" }));
    await waitFor(() => expect(screen.getByText("Copy is still preparing")).toBeVisible());
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    dialog.unmount();

    render(<PendingTemplateCopies result={pendingResult} actions={actions} />);
    expect(screen.getByText("Offer (copy)")).toBeVisible();
    expect(actions.checkEditorReadiness).not.toHaveBeenCalled();
  });

  it("keeps pending recoverable and routes exactly once after an explicit ready result", async () => {
    const actions = makeActions();
    vi.mocked(actions.checkEditorReadiness)
      .mockResolvedValueOnce({ ok: true, data: { readiness: "pending" } })
      .mockResolvedValueOnce({ ok: true, data: { readiness: "ready" } });
    render(<PendingTemplateCopies result={pendingResult} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Copy is still preparing"));
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/esign-templates/pending-1/edit"));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed cancellation visible and retryable", async () => {
    const actions = makeActions();
    vi.mocked(actions.abandonDraft)
      .mockResolvedValueOnce({ ok: false, error: { code: "ABANDON_PROVIDER_FAILED", message: "Dropbox Sign could not remove the draft." } })
      .mockResolvedValueOnce({ ok: true, data: null });
    render(<PendingTemplateCopies result={pendingResult} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Dropbox Sign could not remove the draft."));
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(actions.abandonDraft).toHaveBeenCalledTimes(2);
  });

  it("single-flights repeated Reload clicks and enters one terminal route", async () => {
    const actions = makeActions();
    const ready = deferred<{ ok: true; data: { readiness: "ready" } }>();
    vi.mocked(actions.checkEditorReadiness).mockReturnValue(ready.promise);
    render(<PendingTemplateCopies result={pendingResult} actions={actions} />);
    const reload = screen.getByRole("button", { name: "Reload" });
    fireEvent.click(reload);
    fireEvent.click(reload);
    expect(actions.checkEditorReadiness).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    ready.resolve({ ok: true, data: { readiness: "ready" } });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/esign-templates/pending-1/edit"));
    fireEvent.click(reload);
    expect(actions.checkEditorReadiness).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not route when a late ready check resolves after unmount", async () => {
    const actions = makeActions();
    const ready = deferred<{ ok: true; data: { readiness: "ready" } }>();
    vi.mocked(actions.checkEditorReadiness).mockReturnValue(ready.promise);
    const view = render(<PendingTemplateCopies result={pendingResult} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    view.unmount();
    ready.resolve({ ok: true, data: { readiness: "ready" } });
    await ready.promise;
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });

  it("rediscovers failed cleanup and keeps Retry cleanup failures retryable", async () => {
    const actions = makeActions();
    vi.mocked(actions.retryCleanup)
      .mockResolvedValueOnce({ ok: false, error: { code: "SOURCE_CLEANUP_FAILED", message: "Private source cleanup still requires attention." } })
      .mockResolvedValueOnce({ ok: true, data: null });
    render(<PendingTemplateCopies result={{ ok: true, data: [{ id: "cleanup-1", name: "Offer copy", lifecycle: "cleanup_attention" }] }} actions={actions} />);
    expect(screen.getByText("Cleanup needs attention")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("still requires attention"));
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(actions.abandonDraft).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
