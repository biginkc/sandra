"use client";

import type { TemplateLaneResult } from "./types";

export const DROPBOX_CHOOSER_SIZE_LIMIT = 40 * 1024 * 1024;

export type DropboxChooserFile = Readonly<{
  id: string;
  name: string;
  link: string;
  bytes: number;
  icon: string;
  thumbnailLink?: string;
  isDir?: boolean;
}>;

export type DropboxChooserSdk = Readonly<{
  isBrowserSupported(): boolean;
  choose(options: Readonly<{
    success(files: readonly DropboxChooserFile[]): void;
    cancel(): void;
    linkType: "direct";
    multiselect: false;
    extensions: readonly [".pdf"];
    folderselect: false;
    sizeLimit: number;
  }>): void;
}>;

export async function chooseDropboxPdf(input: {
  sdk: DropboxChooserSdk;
  fetchFile?: typeof fetch;
}): Promise<TemplateLaneResult<File | null>> {
  if (!input.sdk.isBrowserSupported()) {
    return {
      ok: false,
      error: {
        code: "DROPBOX_CHOOSER_UNSUPPORTED",
        message: "Dropbox Chooser is not supported in this browser.",
      },
    };
  }

  return new Promise((resolve) => {
    input.sdk.choose({
      linkType: "direct",
      multiselect: false,
      extensions: [".pdf"],
      folderselect: false,
      sizeLimit: DROPBOX_CHOOSER_SIZE_LIMIT,
      cancel: () => resolve({ ok: true, data: null }),
      success: (files) => {
        const selected = files[0];
        if (
          files.length !== 1 ||
          !selected ||
          selected.isDir ||
          !selected.name.toLowerCase().endsWith(".pdf") ||
          selected.bytes <= 0 ||
          selected.bytes > DROPBOX_CHOOSER_SIZE_LIMIT
        ) {
          resolve({
            ok: false,
            error: {
              code: "DROPBOX_CHOOSER_INVALID_FILE",
              message: "Choose one PDF that is 40 MB or smaller.",
            },
          });
          return;
        }

        // A direct Chooser URL expires. Consume it immediately into a File and
        // expose neither the URL nor the Dropbox identifier to persistence.
        void (input.fetchFile ?? fetch)(selected.link)
          .then(async (response) => {
            if (!response.ok) throw new Error("Dropbox could not download the selected PDF.");
            const blob = await response.blob();
            if (blob.size <= 0 || blob.size > DROPBOX_CHOOSER_SIZE_LIMIT) {
              throw new Error("The downloaded PDF must be 40 MB or smaller.");
            }
            resolve({
              ok: true,
              data: new File([blob], selected.name, {
                type: "application/pdf",
                lastModified: Date.now(),
              }),
            });
          })
          .catch((error: unknown) =>
            resolve({
              ok: false,
              error: {
                code: "DROPBOX_CHOOSER_DOWNLOAD_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : "Dropbox could not download the selected PDF.",
              },
            }),
          );
      },
    });
  });
}
