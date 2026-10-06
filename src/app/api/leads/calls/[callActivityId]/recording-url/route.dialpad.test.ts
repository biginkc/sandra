import { beforeEach, describe, expect, it, vi } from "vitest";

const { authGetUser, maybeSingle, authorize, sign } = vi.hoisted(() => ({
  authGetUser: vi.fn(), maybeSingle: vi.fn(), authorize: vi.fn(), sign: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const query = { select: () => query, eq: () => query, maybeSingle };
    return { auth: { getUser: authGetUser }, from: () => query };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("the Dialpad branch must not use the admin client directly"); } }));
vi.mock("@/lib/recordings/dialpad-audio-playback", () => ({ authorizeDialpadAudio: authorize, signDialpadAudioPath: sign }));

import { GET } from "./route";

const dialpadCall = { id: "call-1", org_id: "org-1", provider: "dialpad", jitter_attempt_id: "dialpad-cti:1", jitter_session_id: null, call_recordings: null };
const request = () => GET(new Request("https://sandra.example.test/x"), { params: Promise.resolve({ callActivityId: "call-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  maybeSingle.mockResolvedValue({ data: dialpadCall, error: null });
  authorize.mockResolvedValue({ audioId: "a1", path: "org-1/call-1/5185307806048256.mp3", sha256: null, durationMs: 36000, mode: "owner" });
  sign.mockResolvedValue({ signedUrl: "https://storage.example.test/dialpad.mp3", expiresAt: "2026-10-06T12:01:00.000Z" });
});

describe("Dialpad recording playback", () => {
  it("authorizes the signed-in user for this org and call, then returns a signed URL for the authorized path", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedUrl: "https://storage.example.test/dialpad.mp3", expiresAt: "2026-10-06T12:01:00.000Z" });
    expect(authorize).toHaveBeenCalledWith({ actorId: "user-1", orgId: "org-1", callActivityId: "call-1" });
    expect(sign).toHaveBeenCalledWith("org-1/call-1/5185307806048256.mp3");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("a denied user gets a plain 404 and nothing is signed", async () => {
    authorize.mockResolvedValue(null);
    const response = await request();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error_code: "not_found" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("a failed authorization lookup is a 500 and a signing failure a 502, never a path", async () => {
    authorize.mockRejectedValueOnce(new Error("57014"));
    expect((await request()).status).toBe(500);
    sign.mockResolvedValueOnce(null);
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("org-1/call-1");
  });

  it("anonymous requests are refused before any lookup and a call with no org is a 404", async () => {
    authGetUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await request()).status).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    maybeSingle.mockResolvedValueOnce({ data: { ...dialpadCall, org_id: undefined }, error: null });
    expect((await request()).status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
  });
});
