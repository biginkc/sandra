import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(async () => ({ ok: true, data: { applied: true } })),
  reject: vi.fn(async () => ({ ok: true, data: { rejected: true } })),
  getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
  memberships: vi.fn(async () => [{ user_id: "user-1", org_id: "org-1", role: "owner" }]),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.memberships }));
vi.mock("../jev/actions", () => ({ confirmJevQueueItem: vi.fn(), correctJevQueueItem: vi.fn() }));
vi.mock("./access", () => ({ messagesV2OrgId: () => "org-1" }));
vi.mock("./luna-resolve", () => ({
  applyLunaSuggestion: mocks.apply,
  rejectLunaSuggestion: mocks.reject,
}));

import { applyLunaSuggestionAction, rejectLunaSuggestionAction } from "./luna-actions";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Luna server actions", () => {
  it("refuse to run when the Luna flag is off (no auth lookup, no resolve)", async () => {
    vi.stubEnv("LUNA_SUGGESTIONS_ENABLED", "");
    const a = await applyLunaSuggestionAction({ suggestionId: "s-1" });
    const r = await rejectLunaSuggestionAction({ suggestionId: "s-1" });
    expect(a).toMatchObject({ ok: false, error: { code: "LUNA_DISABLED" } });
    expect(r).toMatchObject({ ok: false, error: { code: "LUNA_DISABLED" } });
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  it("run normally when the flag is on", async () => {
    vi.stubEnv("LUNA_SUGGESTIONS_ENABLED", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const a = await applyLunaSuggestionAction({ suggestionId: "s-1" });
    expect(a.ok).toBe(true);
    expect(mocks.apply).toHaveBeenCalled();
  });
});
