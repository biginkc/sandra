import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DuplicateTemplateDialog } from "./template-row-actions";
import { PendingTemplateCopies } from "./pending-template-copies";
import {
  InitialEditorSessionProvider,
} from "./initial-editor-session";
import {
  InitialSessionEmbeddedTemplateEditor,
} from "./[templateId]/edit/embedded-template-editor";
import type {
  EsignTemplateRow,
  TemplateEditorActions,
  TemplateLibraryActions,
} from "./types";

const push = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();
const router = { push, refresh, replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

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
    beginEditRevision: vi.fn(),
    checkEditorReadiness: vi.fn().mockResolvedValue({ ok: true, data: { readiness: "pending" } }),
    abandonDraft: vi.fn().mockResolvedValue({ ok: true, data: null }),
    retryCleanup: vi.fn().mockResolvedValue({ ok: true, data: null }),
    retrySourceCleanup: vi.fn().mockResolvedValue({ ok: true, data: null }),
    retryProviderCreate: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        templateId: "template-1",
        initialEditorSession: {
          providerTemplateId: "provider-1",
          editUrl: "https://app.hellosign.com/editor/retry",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          clientId: "client-1",
        },
      },
    }),
    promoteStaleProviderCreate: vi.fn().mockResolvedValue({
      ok: true,
      data: { templateId: "template-1", providerCreateState: "unknown" },
    }),
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

  it("labels a hidden edit revision without exposing it as a finalized template", () => {
    render(<PendingTemplateCopies result={{ ok: true, data: [{ id: "revision-1", name: "Offer", lifecycle: "preparing", kind: "edit_revision" }] }} actions={makeActions()} />);
    expect(screen.getByText("Edit revision is still preparing")).toBeVisible();
    expect(screen.queryByText("Copy is still preparing")).not.toBeInTheDocument();
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
    const retryCancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(retryCancel).toBeEnabled());
    fireEvent.click(retryCancel);
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
    const retry = await screen.findByRole("button", { name: "Retry cleanup" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(actions.abandonDraft).not.toHaveBeenCalled();
  });

  it("routes unattached reservation cleanup through the source cleanup action", async () => {
    const actions = makeActions();
    render(<PendingTemplateCopies result={{ ok: true, data: [{ id: "source-1", name: "offer.pdf", lifecycle: "cleanup_attention", kind: "source_cleanup" }] }} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(actions.retrySourceCleanup).toHaveBeenCalledWith("source-1");
    expect(actions.retryCleanup).not.toHaveBeenCalled();
  });

  it("keeps a claimed provider create non-reinvokable and offers only a page reload", () => {
    const actions = makeActions();
    render(<PendingTemplateCopies result={{ ok: true, data: [{ id: "template-1", name: "Offer", lifecycle: "provider_attention", kind: "provider_create", providerCreateState: "claimed" }] }} actions={actions} />);
    expect(screen.getByText("Provider setup needs attention")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry cleanup" })).not.toBeInTheDocument();
  });

  it("hands Retry setup's editor session to the destination without calling startEditor", async () => {
    const actions = makeActions();
    const editorActions: TemplateEditorActions = {
      startEditor: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "UNEXPECTED_PREFLIGHT", message: "must not run" },
      }),
      restartPlacement: vi.fn(),
      syncFinishedTemplate: vi.fn(),
      abandonDraft: vi.fn(),
    };
    const client = {
      on: vi.fn(),
      off: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
    };
    const loadClient = vi.fn().mockResolvedValue(client);
    const view = render(
      <InitialEditorSessionProvider>
        <div>
          <span data-testid="route-provider-anchor" />
          <PendingTemplateCopies result={{ ok: true, data: [{ id: "template-1", name: "Offer", lifecycle: "provider_attention", kind: "provider_create", providerCreateState: "unstarted" }] }} actions={actions} />
        </div>
      </InitialEditorSessionProvider>,
    );
    expect(screen.getByText(/rejected the previous request without creating a template/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await waitFor(() => expect(actions.retryProviderCreate).toHaveBeenCalledWith("template-1"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/esign-templates/template-1/edit"));
    expect(actions.checkEditorReadiness).not.toHaveBeenCalled();
    view.rerender(
      <InitialEditorSessionProvider>
        <div>
          <span data-testid="route-provider-anchor" />
          <InitialSessionEmbeddedTemplateEditor
            template={{
              id: "template-1",
              name: "Offer",
              sourceFilename: "offer.pdf",
              sourceSizeBytes: 1024,
              pageCount: 1,
              fieldCount: 5,
              isFinalized: false,
            }}
            actions={editorActions}
            loadClient={loadClient}
          />
        </div>
      </InitialEditorSessionProvider>,
    );
    await waitFor(() =>
      expect(client.open).toHaveBeenCalledWith(
        "https://app.hellosign.com/editor/retry",
        expect.any(Object),
      ),
    );
    expect(editorActions.startEditor).not.toHaveBeenCalled();
  });

  it("checks a possibly stale invoking attempt before refreshing its recovery state", async () => {
    const actions = makeActions();
    render(<PendingTemplateCopies result={{ ok: true, data: [{ id: "template-1", name: "Offer", lifecycle: "provider_attention", kind: "provider_create", providerCreateState: "invoking" }] }} actions={actions} />);
    expect(screen.getByText(/Contact an administrator for provider recovery/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Check recovery" }));
    await waitFor(() =>
      expect(actions.promoteStaleProviderCreate).toHaveBeenCalledWith("template-1"),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(actions.retryProviderCreate).not.toHaveBeenCalled();
  });

  it("keeps a fresh invoking attempt fenced when recovery is checked too early", async () => {
    const actions = makeActions();
    vi.mocked(actions.promoteStaleProviderCreate!).mockResolvedValue({
      ok: false,
      error: {
        code: "PROVIDER_RECOVERY_NOT_STALE",
        message: "Provider creation is still in progress. Try again after the recovery window.",
      },
    });
    render(<PendingTemplateCopies result={{ ok: true, data: [{ id: "template-1", name: "Offer", lifecycle: "provider_attention", kind: "provider_create", providerCreateState: "invoking" }] }} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Check recovery" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Provider creation is still in progress",
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(actions.retryProviderCreate).not.toHaveBeenCalled();
  });

  it("keeps unknown recovery out of the normal provider-ID UI", () => {
    const actions = makeActions();
    render(<PendingTemplateCopies result={{ ok: true, data: [{ id: "template-1", name: "Offer", lifecycle: "provider_attention", kind: "provider_create", providerCreateState: "unknown" }] }} actions={actions} />);
    expect(screen.getByText(/Contact an administrator for provider recovery/)).toBeVisible();
    expect(screen.queryByPlaceholderText("Provider template ID")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(actions.promoteStaleProviderCreate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("continues an attached unfinished draft without invoking provider recovery", () => {
    const actions = makeActions();
    render(<PendingTemplateCopies result={{ ok: true, data: [{ id: "template-1", name: "Offer", lifecycle: "provider_attention", kind: "provider_create", providerCreateState: "attached" }] }} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
    expect(push).toHaveBeenCalledWith("/settings/esign-templates/template-1/edit");
  });

  it("keeps a failed attached-draft cancellation visible and retryable", async () => {
    const actions = makeActions();
    vi.mocked(actions.abandonDraft)
      .mockResolvedValueOnce({ ok: false, error: { code: "ABANDON_LOCAL_FAILED", message: "The replacement is ready, but the old draft still needs cleanup." } })
      .mockResolvedValueOnce({ ok: true, data: null });
    render(<PendingTemplateCopies result={{ ok: true, data: [{ id: "template-1", name: "Offer", lifecycle: "provider_attention", kind: "provider_create", providerCreateState: "attached" }] }} actions={actions} />);

    expect(screen.getByRole("button", { name: "Continue setup" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("old draft still needs cleanup"));
    expect(refresh).not.toHaveBeenCalled();

    const retryCancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(retryCancel).toBeEnabled());
    fireEvent.click(retryCancel);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(actions.abandonDraft).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
