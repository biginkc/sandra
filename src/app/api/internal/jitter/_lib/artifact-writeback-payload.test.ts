import { describe, expect, it } from "vitest";

import {
  parseRecordingWritebackBody,
  parseTranscriptWritebackBody,
} from "./artifact-writeback-payload";

describe("artifact writeback payload validation", () => {
  it("rejects malformed, array, and null JSON bodies", () => {
    expect(parseRecordingWritebackBody("{")).toEqual({
      ok: false,
      field: "body",
    });
    expect(parseRecordingWritebackBody("[]")).toEqual({
      ok: false,
      field: "body",
    });
    expect(parseTranscriptWritebackBody("null")).toEqual({
      ok: false,
      field: "body",
    });
  });

  it("rejects corrupt recording metadata", () => {
    expect(
      parseRecordingWritebackBody(
        JSON.stringify({ status: "available", duration_seconds: -1 }),
      ),
    ).toEqual({ ok: false, field: "duration_seconds" });
    expect(
      parseRecordingWritebackBody(
        JSON.stringify({ status: "available", storage_path: 42 }),
      ),
    ).toEqual({ ok: false, field: "storage_path" });
  });

  it("rejects corrupt transcript and summary metadata", () => {
    expect(
      parseTranscriptWritebackBody(
        JSON.stringify({ status: "available", text: ["not", "text"] }),
      ),
    ).toEqual({ ok: false, field: "text" });
    expect(
      parseTranscriptWritebackBody(
        JSON.stringify({ status: "available", summary_status: 1 }),
      ),
    ).toEqual({ ok: false, field: "summary_status" });
  });
});
