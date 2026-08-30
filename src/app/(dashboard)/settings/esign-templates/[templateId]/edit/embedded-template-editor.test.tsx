import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TemplateEditorActions } from "../../types";
import type { EmbeddedTemplateClient } from "./embedded-template-client";
import { EmbeddedTemplateEditor } from "./embedded-template-editor";

const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

describe("EmbeddedTemplateEditor", () => {
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
          skipDomainVerification: false,
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
          mergeFieldNames: ["seller_name", "property_address", "offer_price", "closing_date", "earnest_money"],
        },
      }),
      abandonDraft: vi.fn(),
    };
    render(
      <EmbeddedTemplateEditor
        template={{ id: "local-1", name: "Offer", sourceFilename: "offer.pdf", sourceSizeBytes: 1024, pageCount: 1, fieldCount: 5, isFinalized: false }}
        actions={actions}
        loadClient={vi.fn().mockResolvedValue(client)}
      />,
    );

    const container = screen.getByTestId("embedded-template-container");
    expect(container.className).toContain("min-h-[520px]");
    expect(container.className).toContain("w-full");
    const save = screen.getByRole("button", { name: "Save template" });
    expect(save).toBeDisabled();
    await waitFor(() => expect(client.open).toHaveBeenCalled());

    await act(async () => listeners.get("finish")?.(undefined as never));
    await waitFor(() => expect(actions.syncFinishedTemplate).toHaveBeenCalled());
    expect(save).toBeEnabled();
  });
});
