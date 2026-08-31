import { describe, expect, it } from "vitest";

import { classifyDropboxSignFilesError } from "./dropbox-files";

describe("Dropbox Sign Files error classification", () => {
  it("treats files-preparing 409 as retryable", () => {
    expect(
      classifyDropboxSignFilesError({ statusCode: 409, retryAfter: null }),
    ).toEqual({
      retryable: true,
      reason: "files_preparing",
      retryAfterSeconds: null,
    });
  });

  it("preserves a safe numeric retry delay for throttling", () => {
    expect(
      classifyDropboxSignFilesError({ statusCode: 429, retryAfter: "12" }),
    ).toEqual({
      retryable: true,
      reason: "rate_limited",
      retryAfterSeconds: 12,
    });
  });

  it("does not retry ordinary client rejection", () => {
    expect(
      classifyDropboxSignFilesError({ statusCode: 404, retryAfter: "secret" }),
    ).toEqual({
      retryable: false,
      reason: "rejected",
      retryAfterSeconds: null,
    });
  });
});
