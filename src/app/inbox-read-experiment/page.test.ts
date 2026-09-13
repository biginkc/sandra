import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), membership: vi.fn(), list: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
vi.mock("@/lib/auth/memberships", () => ({ getSingleActiveMembership: mocks.membership }));
vi.mock("@/lib/messages/list-threads", () => ({ listThreadPage: mocks.list }));
vi.mock("./read-experiment", () => ({ ReadExperiment: () => null }));
import Page from "./page";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("experimental page access", () => {
  it("is disabled before page authentication or list reads", async () => {
    vi.stubEnv("INBOX_V2_EXPERIMENT_ENABLED", undefined);
    await expect(Page()).rejects.toThrow("NOT_FOUND");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("requires an authenticated user before membership and data reads", async () => {
    vi.stubEnv("INBOX_V2_EXPERIMENT_ENABLED", "1");
    mocks.create.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } });
    await expect(Page()).rejects.toThrow("REDIRECT");
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
