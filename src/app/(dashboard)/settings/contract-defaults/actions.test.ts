import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  membership: { ok: true, membership: { user_id: "u1", org_id: "o1", role: "owner" } } as unknown,
  ready: true,
  upsert: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/auth/memberships", () => ({ getSingleActiveMembership: async () => m.membership }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: async () => m.ready }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ upsert: m.upsert, insert: m.insert }),
  }),
}));

import { saveContractSettingsAction, saveMarketDefaultAction, saveTitleCompanyAction } from "./actions";

const settings = {
  earnestMoney: "1",
  followUpDays: 3,
  followUpHour: 9,
  defaultTitleCompanyId: null,
  defaultBuyerEntityId: null,
  templateFieldDefaultsText: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.membership = { ok: true, membership: { user_id: "u1", org_id: "o1", role: "owner" } };
  m.ready = true;
  m.upsert.mockResolvedValue({ error: null });
  m.insert.mockResolvedValue({ error: null });
});

describe("contract defaults actions", () => {
  it("rejects non-owners before touching the database", async () => {
    m.membership = { ok: true, membership: { user_id: "u1", org_id: "o1", role: "member" } };
    expect((await saveTitleCompanyAction({ name: "a", closingAgentName: "b", isActive: true })).ok).toBe(false);
    expect(m.insert).not.toHaveBeenCalled();
  });
  it("refuses when the schema is not ready", async () => {
    m.ready = false;
    expect((await saveContractSettingsAction(settings)).ok).toBe(false);
    expect(m.upsert).not.toHaveBeenCalled();
  });
  it("requires title company and closing agent names", async () => {
    expect((await saveTitleCompanyAction({ name: " ", closingAgentName: "b", isActive: true })).ok).toBe(false);
    expect((await saveTitleCompanyAction({ name: "a", closingAgentName: "", isActive: true })).ok).toBe(false);
  });
  it("refuses blank earnest money", async () => {
    const r = await saveContractSettingsAction({ ...settings, earnestMoney: "" });
    expect(r.ok).toBe(false);
    expect(m.upsert).not.toHaveBeenCalled();
  });
  it("rejects invalid or economic template default keys", async () => {
    for (const text of ["earnest_money=5", "bogus=1"]) {
      expect((await saveContractSettingsAction({ ...settings, templateFieldDefaultsText: text })).ok).toBe(false);
    }
    expect(m.upsert).not.toHaveBeenCalled();
  });
  it("upserts explicit values for the owner's org", async () => {
    const r = await saveContractSettingsAction({ ...settings, earnestMoney: "2.50", templateFieldDefaultsText: "buyer_phone=1" });
    expect(r).toEqual({ ok: true });
    expect(m.upsert.mock.calls[0][0]).toMatchObject({ org_id: "o1", earnest_money_cents: 250, template_field_defaults: { buyer_phone: "1" } });
  });
  it("validates market and state", async () => {
    expect((await saveMarketDefaultAction({ market: "Mars", titleCompanyId: "t" })).ok).toBe(false);
    expect((await saveMarketDefaultAction({ market: "Dayton", stateCode: "OHIO", titleCompanyId: "t" })).ok).toBe(false);
    expect((await saveMarketDefaultAction({ market: "Dayton", stateCode: "oh", titleCompanyId: "t" })).ok).toBe(true);
    expect(m.insert.mock.calls[0][0]).toMatchObject({ state_code: "OH", org_id: "o1" });
  });
});
