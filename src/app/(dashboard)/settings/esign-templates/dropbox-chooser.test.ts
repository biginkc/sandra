import { describe, expect, it, vi } from "vitest";

import {
  chooseDropboxPdf,
  DROPBOX_CHOOSER_SIZE_LIMIT,
  type DropboxChooserSdk,
} from "./dropbox-chooser";

describe("chooseDropboxPdf", () => {
  it("uses the exact single-PDF direct-link options and consumes the link", async () => {
    let options: Parameters<DropboxChooserSdk["choose"]>[0] | undefined;
    const sdk: DropboxChooserSdk = {
      isBrowserSupported: () => true,
      choose: (value) => { options = value; },
    };
    const fetchFile = vi.fn().mockResolvedValue(
      new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" })),
    );
    const pending = chooseDropboxPdf({ sdk, fetchFile });
    expect(options).toMatchObject({
      linkType: "direct",
      multiselect: false,
      extensions: [".pdf"],
      folderselect: false,
      sizeLimit: DROPBOX_CHOOSER_SIZE_LIMIT,
    });
    options?.success([
      { id: "dropbox-id", name: "offer.pdf", link: "https://temporary", bytes: 8, icon: "icon" },
    ]);
    const result = await pending;
    expect(fetchFile).toHaveBeenCalledWith("https://temporary");
    expect(result.ok && result.data).toBeInstanceOf(File);
    expect(result).not.toEqual(expect.objectContaining({ link: expect.anything() }));
  });

  it("returns null on cancel and fails closed in unsupported browsers", async () => {
    const cancelSdk: DropboxChooserSdk = {
      isBrowserSupported: () => true,
      choose: (options) => options.cancel(),
    };
    await expect(chooseDropboxPdf({ sdk: cancelSdk })).resolves.toEqual({ ok: true, data: null });
    await expect(
      chooseDropboxPdf({ sdk: { isBrowserSupported: () => false, choose: vi.fn() } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "DROPBOX_CHOOSER_UNSUPPORTED" } });
  });
});
