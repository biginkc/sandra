import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ order: vi.fn(), eq: vi.fn(), getBucket: vi.fn(), createSignedUrl: vi.fn() }));
vi.mock("./database", () => ({ createDialpadVoiceAdminClient: () => {
  const query = { select: () => query, eq: h.eq.mockImplementation(() => query), order: h.order };
  return { from: () => query, storage: { getBucket: h.getBucket, from: () => ({ createSignedUrl: h.createSignedUrl }) } };
} }));
import { ownedDialpadPlayback } from "./recording-playback";
const id = "11111111-1111-1111-1111-111111111111";
const sha = "a".repeat(64);
function segment(overrides = {}) { return { id, org_id: "org", provider_call_id: "call", status: "available", storage_bucket: "private", storage_path: `org/call/${id}/${sha}.wav`, content_sha256: sha, byte_count: 10, decoded_duration_seconds: 1, verified_at: "2026-09-13T00:00:00Z", ...overrides }; }
beforeEach(() => { vi.clearAllMocks(); h.order.mockResolvedValue({ data: [segment()] }); h.getBucket.mockResolvedValue({ data: { public: false } }); h.createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://owned.test/temporary" } }); });
describe("owned playback", () => {
  it("signs private verified segment with short TTL", async () => {
    const response = await ownedDialpadPlayback("org", "call", null);
    expect(response.status).toBe(200); expect((await response.json()).signedUrl).toBe("https://owned.test/temporary");
    expect(h.createSignedUrl).toHaveBeenCalledWith(segment().storage_path, 60);
    expect(h.eq).toHaveBeenCalledWith("org_id", "org");
  });
  it.each([{ org_id: "foreign" }, { verified_at: null }, { storage_path: "other-org/secret" }])("rejects untrusted artifact %j", async (override) => {
    h.order.mockResolvedValue({ data: [segment(override)] });
    expect((await ownedDialpadPlayback("org", "call", null)).status).toBe(409); expect(h.createSignedUrl).not.toHaveBeenCalled();
  });
  it("rejects public bucket when signing", async () => {
    h.getBucket.mockResolvedValue({ data: { public: true } });
    expect((await ownedDialpadPlayback("org", "call", null)).status).toBe(409); expect(h.createSignedUrl).not.toHaveBeenCalled();
  });
  it("reports missing retained artifacts", async () => {
    h.order.mockResolvedValue({ data: [] }); expect((await ownedDialpadPlayback("org", "call", null)).status).toBe(409);
  });
  it("requires selection for multiple segments", async () => {
    const second = "22222222-2222-2222-2222-222222222222";
    h.order.mockResolvedValue({ data: [segment(), segment({ id: second, storage_path: `org/call/${second}/${sha}.wav` })] });
    const response = await ownedDialpadPlayback("org", "call", null);
    expect(response.status).toBe(409); expect((await response.json()).recordingSegments).toHaveLength(2); expect(h.createSignedUrl).not.toHaveBeenCalled();
    expect((await ownedDialpadPlayback("org", "call", second)).status).toBe(200);
  });
  it("validates selection and rejects foreign IDs", async () => {
    expect((await ownedDialpadPlayback("org", "call", "../bad")).status).toBe(400);
    expect((await ownedDialpadPlayback("org", "call", "33333333-3333-3333-3333-333333333333")).status).toBe(404);
  });
});
