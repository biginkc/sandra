import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, sign } = vi.hoisted(() => ({
  state: { user: { id: "u1" } as { id: string } | null, row: null as Record<string, unknown> | null },
  sign: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    // The session client: RLS hides other orgs' drops, modelled as row = null.
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: state.row, error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: (bucket: string) => ({ createSignedUrl: (p: string, s: number) => sign(bucket, p, s) }) } }),
}));

import { GET } from "./route";

const ID = "00000000-0000-4000-8000-0000000000d1";
const call = (id = ID) => GET(new Request("https://x/api"), { params: Promise.resolve({ dropRowId: id }) });

beforeEach(() => {
  state.user = { id: "u1" };
  state.row = { id: ID, org_id: "org-1", proof_url: "https://proof.example/t", proof_url_at: new Date().toISOString(), completed_at: null, proof_storage_path: "org-1/d.mp3" };
  sign.mockReset().mockResolvedValue({ data: { signedUrl: "https://storage/signed" }, error: null });
});

describe("GET /api/voicemail-drops/[id]/proof", () => {
  it("redirects to a 60s signed URL for the stored copy", async () => {
    const res = await call();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://storage/signed");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(sign).toHaveBeenCalledWith("voicemail-drop-proofs", "org-1/d.mp3", 60);
  });

  it("falls back to the fresh provider link when signing fails", async () => {
    sign.mockResolvedValue({ data: null, error: { message: "nope" } });
    expect((await call()).headers.get("location")).toBe("https://proof.example/t");
  });

  it("404s a drop the caller's org cannot see, and 401s without a session", async () => {
    state.row = null;
    expect((await call()).status).toBe(404);
    expect(sign).not.toHaveBeenCalled();
    state.user = null;
    expect((await call()).status).toBe(401);
  });

  it("404s a bad id and an expired provider-only proof", async () => {
    expect((await call("../x")).status).toBe(404);
    state.row = { ...state.row, proof_storage_path: null, proof_url_at: "2020-01-01T00:00:00Z" };
    expect((await call()).status).toBe(404);
  });
});
