import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TemplateEditorActions } from "../../types";
import type { EmbeddedTemplateClient } from "./embedded-template-client";
import { EmbeddedTemplateEditor } from "./embedded-template-editor";

const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

describe("EmbeddedTemplateEditor", () => {
  afterEach(() => vi.clearAllMocks());

  it("mounts full-width at 520px and enables Save only after provider Finish syncs", async () => {
    const listeners = new Map<string, (payload: never) => void>();
    const client: EmbeddedTemplateClient = {
      on: vi.fn((event, listener) => listeners.set(event, listener as never)),
      off: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
    };
    const actions: TemplateEditorActions = {
      startEditor: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          providerTemplateId: "provider-1",
          editUrl: "https://edit",
          expiresAt: 123,
          clientId: "client-1",
        },
      }),
      syncFinishedTemplate: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          id: "local-1",
          name: "Offer",
          documentType: "Purchase agreement",
          providerTemplateId: "provider-1",
          signerRoles: [{ name: "Seller", order: 0 }],
          sellerRoleName: "Seller",
          mergeFieldNames: [
            "seller_name",
            "property_address",
            "offer_price",
            "closing_date",
            "earnest_money",
          ],
        },
      }),
      abandonDraft: vi.fn(),
    };
    const loadClient = vi.fn().mockResolvedValue(client);
    const view = render(
      <EmbeddedTemplateEditor
        template={{
          id: "local-1",
          name: "Offer",
          sourceFilename: "offer.pdf",
          sourceSizeBytes: 1024,
          pageCount: 1,
          fieldCount: 5,
          isFinalized: false,
        }}
        actions={actions}
        loadClient={loadClient}
      />,
    );

    const container = screen.getByTestId("embedded-template-container");
    expect(container.className).toContain("min-h-[520px]");
    expect(container.className).toContain("w-full");
    const editor = screen.getByRole("region", {
      name: "Dropbox Sign template editor",
    });
    const fileStrip = screen.getByText("offer.pdf");
    const legend = screen.getByRole("heading", { name: "Sandra merge fields" });
    expect(editor).toContainElement(fileStrip);
    expect(editor).toContainElement(container);
    expect(editor).toContainElement(legend);
    expect(
      fileStrip.compareDocumentPosition(container) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      container.compareDocumentPosition(legend) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const field of [
      "seller_name",
      "property_address",
      "offer_price",
      "closing_date",
      "earnest_money",
    ]) {
      expect(screen.getByText(field)).toBeVisible();
    }
    const save = screen.getByRole("button", { name: "Save template" });
    expect(save).toBeDisabled();
    await waitFor(() => expect(client.open).toHaveBeenCalled());
    expect(loadClient).toHaveBeenCalledTimes(1);
    expect(loadClient).toHaveBeenCalledWith("client-1");
    expect(client.open).toHaveBeenCalledWith(
      "https://edit",
      expect.objectContaining({
        container,
        skipDomainVerification: true,
      }),
    );

    view.rerender(
      <EmbeddedTemplateEditor
        template={{
          id: "local-1",
          name: "Offer",
          sourceFilename: "offer.pdf",
          sourceSizeBytes: 1024,
          pageCount: 1,
          fieldCount: 5,
          isFinalized: false,
        }}
        actions={actions}
        loadClient={loadClient}
      />,
    );
    expect(loadClient).toHaveBeenCalledTimes(1);

    await act(async () => listeners.get("finish")?.(undefined as never));
    await waitFor(() =>
      expect(actions.syncFinishedTemplate).toHaveBeenCalled(),
    );
    expect(save).toBeEnabled();
  });

  it("requests a fresh edit session and client when the editor reloads", async () => {
    const first = makeClient();
    const second = makeClient();
    const actions = makeActions();
    const loadClient = vi
      .fn()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    render(
      <EmbeddedTemplateEditor
        template={template}
        actions={actions}
        loadClient={loadClient}
      />,
    );
    await waitFor(() => expect(first.client.open).toHaveBeenCalled());
    act(() =>
      first.listeners.get("error")?.({ code: "EDIT_URL_EXPIRED" } as never),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Reload editor" }),
    );

    await waitFor(() => expect(second.client.open).toHaveBeenCalled());
    expect(actions.startEditor).toHaveBeenCalledTimes(2);
    expect(loadClient).toHaveBeenCalledTimes(2);
    expect(first.client.close).toHaveBeenCalledTimes(1);
  });

  it("uses the create response session once, then requests a fresh session on reload", async () => {
    const first = makeClient();
    const second = makeClient();
    const actions = makeActions();
    const loadClient = vi
      .fn()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    render(
      <EmbeddedTemplateEditor
        template={template}
        actions={actions}
        loadClient={loadClient}
        initialSession={{
          providerTemplateId: "provider-1",
          editUrl: "https://app.hellosign.com/editor/initial",
          expiresAt: 123,
          clientId: "client-initial",
        }}
      />,
    );

    await waitFor(() =>
      expect(first.client.open).toHaveBeenCalledWith(
        "https://app.hellosign.com/editor/initial",
        expect.any(Object),
      ),
    );
    expect(actions.startEditor).not.toHaveBeenCalled();
    expect(loadClient).toHaveBeenNthCalledWith(1, "client-initial");

    act(() =>
      first.listeners.get("error")?.({ code: "EDIT_URL_EXPIRED" } as never),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Reload editor" }),
    );

    await waitFor(() => expect(second.client.open).toHaveBeenCalled());
    expect(actions.startEditor).toHaveBeenCalledTimes(1);
    expect(loadClient).toHaveBeenCalledTimes(2);
  });

  it("syncs finish before close, but abandons cancel only after close", async () => {
    const finished = makeClient();
    const finishActions = makeActions();
    const finishView = render(
      <EmbeddedTemplateEditor
        template={template}
        actions={finishActions}
        loadClient={vi.fn().mockResolvedValue(finished.client)}
      />,
    );
    await waitFor(() => expect(finished.client.open).toHaveBeenCalled());
    act(() => {
      finished.listeners.get("finish")?.(undefined as never);
      finished.listeners.get("close")?.(undefined as never);
    });
    await waitFor(() =>
      expect(finishActions.syncFinishedTemplate).toHaveBeenCalledTimes(1),
    );
    expect(finishActions.abandonDraft).not.toHaveBeenCalled();
    finishView.unmount();

    const cancelled = makeClient();
    const cancelActions = makeActions();
    const cancelView = render(
      <EmbeddedTemplateEditor
        template={template}
        actions={cancelActions}
        loadClient={vi.fn().mockResolvedValue(cancelled.client)}
      />,
    );
    await waitFor(() => expect(cancelled.client.open).toHaveBeenCalled());
    act(() => cancelled.listeners.get("cancel")?.(undefined as never));
    expect(cancelActions.abandonDraft).not.toHaveBeenCalled();
    act(() => cancelled.listeners.get("close")?.(undefined as never));
    await waitFor(() =>
      expect(cancelActions.abandonDraft).toHaveBeenCalledTimes(1),
    );
    expect(router.push).toHaveBeenCalledWith("/settings/esign-templates");
    cancelView.unmount();
    expect(cancelled.client.close).toHaveBeenCalledTimes(1);
  });
});

const template = {
  id: "local-1",
  name: "Offer",
  sourceFilename: "offer.pdf",
  sourceSizeBytes: 1024,
  pageCount: 1,
  fieldCount: 5,
  isFinalized: false,
} as const;

function makeClient() {
  const listeners = new Map<string, (payload: never) => void>();
  const client: EmbeddedTemplateClient = {
    on: vi.fn((event, listener) => listeners.set(event, listener as never)),
    off: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  };
  return { client, listeners };
}

function makeActions(): TemplateEditorActions {
  return {
    startEditor: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        providerTemplateId: "provider-1",
        editUrl: "https://edit",
        expiresAt: 123,
        clientId: "client-1",
      },
    }),
    syncFinishedTemplate: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        id: "local-1",
        name: "Offer",
        documentType: "Purchase agreement",
        providerTemplateId: "provider-1",
        signerRoles: [{ name: "Seller", order: 0 }],
        sellerRoleName: "Seller",
        mergeFieldNames: [
          "seller_name",
          "property_address",
          "offer_price",
          "closing_date",
          "earnest_money",
        ],
      },
    }),
    abandonDraft: vi.fn().mockResolvedValue({ ok: true, data: null }),
  };
}
