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

import { saveContractSettingsAction, saveTitleCompanyAction } from "./actions";

const settings = {
  followUpDays: 3,
  followUpHour: 9,
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
  it("rejects invalid or economic template default keys", async () => {
    for (const text of ["earnest_money=5", "bogus=1"]) {
      expect((await saveContractSettingsAction({ ...settings, templateFieldDefaultsText: text })).ok).toBe(false);
    }
    expect(m.upsert).not.toHaveBeenCalled();
  });
  it("upserts explicit values for the owner's org", async () => {
    const r = await saveContractSettingsAction({ ...settings, templateFieldDefaultsText: "buyer_phone=1" });
    expect(r).toEqual({ ok: true });
    expect(m.upsert.mock.calls[0][0]).toMatchObject({ org_id: "o1", template_field_defaults: { buyer_phone: "1" } });
  });
  it("saves with no earnest money and writes none of the removed default columns", async () => {
    expect(await saveContractSettingsAction(settings)).toEqual({ ok: true });
    const row = m.upsert.mock.calls[0][0];
    expect(row).not.toHaveProperty("earnest_money_cents");
    expect(row).not.toHaveProperty("default_title_company_id");
    expect(row).not.toHaveProperty("default_buyer_entity_id");
    expect(Object.keys(row).sort()).toEqual(
      ["follow_up_days_before_closing", "follow_up_hour_central", "org_id", "template_field_defaults", "updated_at", "updated_by"],
    );
  });
});
