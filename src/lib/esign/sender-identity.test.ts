import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getUserById: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { getUserById: mocks.getUserById } } }),
}));
import { loadEsignCreatorLabel } from "./sender-identity";

describe("eSign request creator identity", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());
  it("uses the exact persisted creator and only administrator-controlled names", async () => {
    mocks.getUserById.mockResolvedValue({ data: { user: {
      id: "creator-1", app_metadata: { full_name: "Maria Unkovich" },
      user_metadata: { full_name: "Different Person" },
    } }, error: null });
    expect(await loadEsignCreatorLabel("creator-1")).toBe("Maria Unkovich");
    expect(mocks.getUserById).toHaveBeenCalledWith("creator-1");
  });
  it("falls back to confirmed email rather than editable metadata", async () => {
    mocks.getUserById.mockResolvedValue({ data: { user: {
      id: "creator-1", email: "maria@example.com", email_confirmed_at: "2026-09-12",
      user_metadata: { full_name: "Invented Name" },
    } }, error: null });
    expect(await loadEsignCreatorLabel("creator-1")).toBe("maria@example.com");
  });
  it.each([
    { id: "another-user", app_metadata: { name: "Wrong identity" } },
    { id: "creator-1", email: "unverified@example.com", user_metadata: { name: "Fake" } },
    null,
  ])("does not attribute mismatched, unverified or deleted identities", async user => {
    mocks.getUserById.mockResolvedValue({ data: { user }, error: null });
    expect(await loadEsignCreatorLabel("creator-1")).toBeNull();
  });
  it("bounds an unavailable identity service so history and sends can continue", async () => {
    vi.useFakeTimers();
    mocks.getUserById.mockReturnValue(new Promise(() => {}));
    const lookup = loadEsignCreatorLabel("creator-1");
    await vi.advanceTimersByTimeAsync(1500);
    expect(await lookup).toBeNull();
  });
  it("preserves history availability when auth lookup fails", async () => {
    mocks.getUserById.mockRejectedValue(new Error("unavailable"));
    expect(await loadEsignCreatorLabel("creator-1")).toBeNull();
    expect(await loadEsignCreatorLabel(null)).toBeNull();
    expect(mocks.getUserById).toHaveBeenCalledTimes(1);
  });
});
