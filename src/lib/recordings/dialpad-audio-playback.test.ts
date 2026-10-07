import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, createSignedUrl, from, order } = vi.hoisted(() => ({
  rpc: vi.fn(), createSignedUrl: vi.fn(), from: vi.fn(), order: [] as string[],
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc, storage: { from } }) }));

import { getDialpadCallAudio } from "./dialpad-audio-consumer";
import { authorizeDialpadAudio, signDialpadAudioPath } from "./dialpad-audio-playback";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CALL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATH = `${ORG_A}/${CALL}/5185307806048256.mp3`;
const grant = { audioId: "audio-1", bucket: "dialpad-call-audio", path: PATH, sha256: "a".repeat(64), durationMs: 36000, mode: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  from.mockReturnValue({ createSignedUrl });
  createSignedUrl.mockImplementation(async () => { order.push("sign"); return { data: { signedUrl: "https://storage.example.test/signed" }, error: null }; });
});

describe("authorizeDialpadAudio", () => {
  it("passes the actor, org and call to the SQL authorization and returns the grant", async () => {
    rpc.mockResolvedValue({ data: grant, error: null });
    expect(await authorizeDialpadAudio({ actorId: "user-1", orgId: ORG_A, callActivityId: CALL })).toEqual({
      audioId: "audio-1", path: PATH, sha256: "a".repeat(64), durationMs: 36000, mode: "owner",
    });
    expect(rpc).toHaveBeenCalledWith("fn_dialpad_audio_authorize", { p_actor: "user-1", p_org_id: ORG_A, p_call_activity_id: CALL });
  });

  it.each([[null], [{}], [{ ...grant, bucket: "dialpad-recordings" }], [{ ...grant, path: "" }], [{ ...grant, mode: "machine" }]])("a denied or malformed answer (%j) is null", async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    expect(await authorizeDialpadAudio({ actorId: "user-1", orgId: ORG_A, callActivityId: CALL })).toBeNull();
  });

  it("a failed lookup throws instead of reading as a denial", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014" } });
    await expect(authorizeDialpadAudio({ actorId: "user-1", orgId: ORG_A, callActivityId: CALL })).rejects.toThrow("57014");
  });
});

describe("signDialpadAudioPath", () => {
  it("signs 60 seconds from the private dialpad-call-audio bucket only", async () => {
    const signed = await signDialpadAudioPath(PATH);
    expect(from).toHaveBeenCalledWith("dialpad-call-audio");
    expect(createSignedUrl).toHaveBeenCalledWith(PATH, 60);
    expect(signed?.signedUrl).toBe("https://storage.example.test/signed");
    expect(Math.abs(new Date(signed!.expiresAt).getTime() - (Date.now() + 60_000))).toBeLessThan(2000);
  });

  it("returns null when Storage cannot sign", async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "nope" } });
    expect(await signDialpadAudioPath(PATH)).toBeNull();
  });
});

describe("getDialpadCallAudio (Jev / coach)", () => {
  const serviceGrant = { audioId: "audio-1", id: "dpa_audio-1", bucket: "dialpad-call-audio", path: PATH, sha256: "a".repeat(64), durationMs: 36000 };

  it("asks the tenant-bound SQL function with the caller's org and consumer, and signs only after it grants", async () => {
    rpc.mockImplementation(async () => { order.push("authorize"); return { data: serviceGrant, error: null }; });
    const audio = await getDialpadCallAudio({ orgId: ORG_A, callActivityId: CALL, consumer: "jev" });
    expect(rpc).toHaveBeenCalledWith("fn_dialpad_audio_for_service", { p_org_id: ORG_A, p_call_activity_id: CALL, p_consumer: "jev" });
    expect(order).toEqual(["authorize", "sign"]);
    expect(audio).toMatchObject({ id: "dpa_audio-1", sha256: "a".repeat(64), durationMs: 36000, signedUrl: "https://storage.example.test/signed" });
  });

  it("org B asking for org A's call (both orgs have jev on) is denied by SQL and nothing is signed", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await getDialpadCallAudio({ orgId: ORG_B, callActivityId: CALL, consumer: "jev" })).toBeNull();
    expect(rpc).toHaveBeenCalledWith("fn_dialpad_audio_for_service", { p_org_id: ORG_B, p_call_activity_id: CALL, p_consumer: "jev" });
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("an answer for another bucket is refused and a signing failure is a null, never an exception with a path", async () => {
    rpc.mockResolvedValue({ data: { ...serviceGrant, bucket: "dialpad-recordings" }, error: null });
    expect(await getDialpadCallAudio({ orgId: ORG_A, callActivityId: CALL, consumer: "coach_review" })).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: serviceGrant, error: null });
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await getDialpadCallAudio({ orgId: ORG_A, callActivityId: CALL, consumer: "coach_review" })).toBeNull();
  });

  it("a failed lookup throws", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(getDialpadCallAudio({ orgId: ORG_A, callActivityId: CALL, consumer: "jev" })).rejects.toThrow("42501");
  });
});
