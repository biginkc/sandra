import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { DialpadVoiceDatabase } from "./database.generated";
import { retainDialpadRecording } from "./recording-storage";

const bytes = Buffer.from("decoded-fixture-bytes");
const artifact = { id: "artifact", org_id: "org", provider_call_id: "call", provider_recording_id: "recording", status: "processing", lease_token: "lease" };
const download = { ok: true as const, verification: "decoded" as const, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), format: "wav" as const, mimeType: "application/octet-stream", decoded: { durationSeconds: 1, channels: 1, sampleRate: 8000 } };
function harness() {
  const getBucket = vi.fn().mockResolvedValue({ data: { public: false }, error: null });
  const upload = vi.fn().mockResolvedValue({ error: null });
  const read = vi.fn().mockResolvedValue({ data: new Blob([bytes]), error: null });
  const select = vi.fn().mockResolvedValue({ data: [{ id: artifact.id }], error: null });
  const eq = vi.fn(); const query = { eq, select }; eq.mockReturnValue(query);
  const update = vi.fn().mockReturnValue(query);
  const from = vi.fn().mockReturnValue({ update });
  const client = { storage: { getBucket, from: vi.fn().mockReturnValue({ upload, download: read }) }, from } as unknown as SupabaseClient<DialpadVoiceDatabase>;
  return { getBucket, upload, read, select, eq, update, from, run: (claimed = artifact) => retainDialpadRecording({ client, artifact: claimed, download, bucket: "private-audio" }) };
}
describe("retained recording storage", () => {
  it("verifies private bytes before CAS marking available", async () => {
    const h = harness(); expect((await h.run()).ok).toBe(true);
    expect(h.upload.mock.calls[0][2]).toMatchObject({ upsert: false, contentType: "audio/wav" });
    expect(h.update.mock.calls[0][0]).toMatchObject({ status: "available", content_sha256: download.sha256, byte_count: bytes.length, lease_token: null });
    expect(h.eq.mock.calls).toEqual([["org_id", "org"], ["id", "artifact"], ["status", "processing"], ["lease_token", "lease"]]);
    expect(h.read.mock.invocationCallOrder[0]).toBeLessThan(h.update.mock.invocationCallOrder[0]);
  });
  it("accepts opaque recording ID without using it as a path", async () => {
    const h = harness();
    expect((await h.run({ ...artifact, provider_recording_id: "opaque/recording:id" })).ok).toBe(true);
    expect(h.upload.mock.calls[0][0]).not.toContain("opaque");
  });
  it("refuses public bucket before upload", async () => {
    const h = harness(); h.getBucket.mockResolvedValue({ data: { public: true } });
    expect(await h.run()).toEqual({ ok: false, reason: "private_bucket_required" }); expect(h.upload).not.toHaveBeenCalled();
  });
  it("does not mark failed uploads available", async () => {
    const h = harness(); h.upload.mockResolvedValue({ error: { statusCode: "500", message: "secret" } });
    expect(await h.run()).toEqual({ ok: false, reason: "upload_failed" }); expect(h.update).not.toHaveBeenCalled();
  });
  it("rejects corrupt same-length readback", async () => {
    const h = harness(); h.read.mockResolvedValue({ data: new Blob([Buffer.alloc(bytes.length)]) });
    expect(await h.run()).toEqual({ ok: false, reason: "readback_mismatch" }); expect(h.update).not.toHaveBeenCalled();
  });
  it("checks blob size before reading memory", async () => {
    const h = harness(); const arrayBuffer = vi.fn(); h.read.mockResolvedValue({ data: { size: 1e9, arrayBuffer } });
    expect(await h.run()).toEqual({ ok: false, reason: "readback_mismatch" }); expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it("reports lost lease without success", async () => {
    const h = harness(); h.select.mockResolvedValue({ data: [], error: null });
    expect(await h.run()).toEqual({ ok: false, reason: "lost_lease" });
  });
  it("reuses identical object after conflict only with readback proof", async () => {
    const h = harness(); h.upload.mockResolvedValue({ error: { status: 409, statusCode: "ResourceAlreadyExists" } });
    expect((await h.run()).ok).toBe(true); expect((await h.run()).ok).toBe(true);
    expect(h.upload.mock.calls[0][0]).toBe(h.upload.mock.calls[1][0]); expect(h.read).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ status: 400, message: "Asset Already Exists" }, true],
    [{ status: 400, statusCode: "ResourceAlreadyExists" }, true],
    [{ status: 409, statusCode: "KeyAlreadyExists" }, true],
    [{ status: 400, message: "Invalid request" }, false],
  ])("handles documented duplicate response %j", async (error, expected) => {
    const h = harness(); h.upload.mockResolvedValue({ error });
    const result = await h.run(); expect(result.ok).toBe(expected);
    if (!expected) { expect(result).toEqual({ ok: false, reason: "upload_failed" }); expect(h.read).not.toHaveBeenCalled(); }
    else expect(h.read).toHaveBeenCalledTimes(1);
  });
  it("rejects conflict when retained object differs", async () => {
    const h = harness(); h.upload.mockResolvedValue({ error: { statusCode: "409" } }); h.read.mockResolvedValue({ data: new Blob(["bad"]) });
    expect(await h.run()).toEqual({ ok: false, reason: "readback_mismatch" }); expect(h.update).not.toHaveBeenCalled();
  });
  it("sanitizes storage exception", async () => {
    const h = harness(); h.read.mockRejectedValue(Error("secret URL"));
    expect(await h.run()).toEqual({ ok: false, reason: "readback_failed" }); expect(h.update).not.toHaveBeenCalled();
  });
});
