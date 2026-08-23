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
        JSON.stringify({
          status: "available",
          storage_path: "calls/invalid.wav",
          duration_seconds: -1,
        }),
      ),
    ).toEqual({ ok: false, field: "duration_seconds" });
    expect(
      parseRecordingWritebackBody(
        JSON.stringify({
          status: "available",
          storage_path: "calls/overflow.wav",
          duration_seconds: 2_147_483_648,
        }),
      ),
    ).toEqual({ ok: false, field: "duration_seconds" });
    expect(
      parseRecordingWritebackBody(
        JSON.stringify({ status: "available", storage_path: 42 }),
      ),
    ).toEqual({ ok: false, field: "storage_path" });
    for (const storage_path of [undefined, null, "", "   "]) {
      expect(
        parseRecordingWritebackBody(
          JSON.stringify({ status: "available", storage_path }),
        ),
      ).toEqual({ ok: false, field: "storage_path" });
    }
    expect(
      parseRecordingWritebackBody(JSON.stringify({ status: "pending" })),
    ).toMatchObject({ ok: true });
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
    for (const text of [undefined, null, "", "   "]) {
      expect(
        parseTranscriptWritebackBody(
          JSON.stringify({ status: "available", text }),
        ),
      ).toEqual({ ok: false, field: "text" });
    }
    for (const summary of [undefined, null, "", "   "]) {
      expect(
        parseTranscriptWritebackBody(
          JSON.stringify({
            status: "available",
            text: "Transcript",
            summary_status: "available",
            summary,
          }),
        ),
      ).toEqual({ ok: false, field: "summary" });
    }
    for (const status of ["pending", "failed"]) {
      for (const summaryStatus of ["pending", "failed", "available"]) {
        expect(
          parseTranscriptWritebackBody(
            JSON.stringify({
              status,
              summary_status: summaryStatus,
              summary: summaryStatus === "available" ? "Summary" : undefined,
            }),
          ),
        ).toEqual({ ok: false, field: "summary_status" });
      }
    }
    expect(
      parseTranscriptWritebackBody(
        JSON.stringify({ status: "failed", summary_status: "none" }),
      ),
    ).toMatchObject({ ok: true });
  });
});
