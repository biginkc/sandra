import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminClient } = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { getMyLeadsFlag, getMyLeadsFlags, MY_LEADS_FLAGS } from "./flags";

function clientReturning(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  createAdminClient.mockReturnValue({ from });
  return { from, select, eq };
}

describe("getMyLeadsFlag", () => {
  beforeEach(() => createAdminClient.mockReset());

  it("lists all thirteen flags", () => {
    expect(MY_LEADS_FLAGS).toHaveLength(13);
  });

  it("returns true only when the column is true", async () => {
    const c = clientReturning({ data: { call_screen: true }, error: null });
    expect(await getMyLeadsFlag("org-1", "call_screen")).toBe(true);
    expect(c.from).toHaveBeenCalledWith("my_leads_feature_flags");
    expect(c.select).toHaveBeenCalledWith("call_screen");
    expect(c.eq).toHaveBeenCalledWith("org_id", "org-1");
    clientReturning({ data: { call_screen: false }, error: null });
    expect(await getMyLeadsFlag("org-1", "call_screen")).toBe(false);
  });

  it("reads OFF for a missing row", async () => {
    clientReturning({ data: null, error: null });
    expect(await getMyLeadsFlag("org-1", "comp_queue")).toBe(false);
  });

  it.each(["42P01", "42703", "XX000"])("reads OFF on error %s", async (code) => {
    clientReturning({ data: null, error: { code, message: "boom" } });
    expect(await getMyLeadsFlag("org-1", "comp_queue")).toBe(false);
  });

  it("reads OFF when the client throws", async () => {
    createAdminClient.mockReturnValue({
      from: () => {
        throw new Error("no env");
      },
    });
    expect(await getMyLeadsFlag("org-1", "comp_queue")).toBe(false);
  });

  it("reads OFF for an unknown flag without querying", async () => {
    const c = clientReturning({ data: { x: true }, error: null });
    expect(await getMyLeadsFlag("org-1", "x" as never)).toBe(false);
    expect(c.from).not.toHaveBeenCalled();
  });
});

describe("getMyLeadsFlags", () => {
  beforeEach(() => createAdminClient.mockReset());

  it("reads several flags in one query", async () => {
    const c = clientReturning({ data: { click_to_dial: true, auto_prompt: false }, error: null });
    expect(await getMyLeadsFlags("org-1", ["click_to_dial", "auto_prompt", "callback_alert"])).toEqual({
      click_to_dial: true, auto_prompt: false, callback_alert: false,
    });
    expect(c.from).toHaveBeenCalledTimes(1);
    expect(c.select).toHaveBeenCalledWith("click_to_dial, auto_prompt, callback_alert");
  });

  it("reads every flag OFF on a missing row or an error", async () => {
    clientReturning({ data: null, error: null });
    expect(await getMyLeadsFlags("org-1", ["click_to_dial"])).toEqual({ click_to_dial: false });
    clientReturning({ data: null, error: { code: "42703" } });
    expect(await getMyLeadsFlags("org-1", ["click_to_dial", "auto_prompt"])).toEqual({ click_to_dial: false, auto_prompt: false });
  });
});
