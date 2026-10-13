import { describe, expect, it, vi } from "vitest";

import { setReplyGeneration } from "./reply-generation";

const client = (result: { data: unknown; error: { code?: string; message?: string } | null }) => ({
  rpc: vi.fn(async () => result),
});

describe("setReplyGeneration", () => {
  it("passes the config and mode to the owner-only RPC and returns the stored value", async () => {
    const c = client({ data: { id: "cfg", replyGeneration: "off" }, error: null });
    const r = await setReplyGeneration(c, { configId: "cfg", mode: "off" });
    expect(c.rpc).toHaveBeenCalledWith("fn_set_ai_reply_generation", { p_config_id: "cfg", p_mode: "off" });
    expect(r).toEqual({ ok: true, data: { configId: "cfg", replyGeneration: "off" } });
  });
  it("maps a database refusal to FORBIDDEN", async () => {
    const r = await setReplyGeneration(client({ data: null, error: { code: "42501" } }), { configId: "cfg", mode: "off" });
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
  it("maps other failures to SET_FAILED and never claims success", async () => {
    const r = await setReplyGeneration(client({ data: null, error: { code: "XX000" } }), { configId: "cfg", mode: "llm" });
    expect(r).toMatchObject({ ok: false, error: { code: "SET_FAILED" } });
    const odd = await setReplyGeneration(client({ data: {}, error: null }), { configId: "cfg", mode: "llm" });
    expect(odd).toMatchObject({ ok: false, error: { code: "SET_FAILED" } });
  });
  it("rejects an unknown mode without calling the database", async () => {
    const c = client({ data: null, error: null });
    expect(await setReplyGeneration(c, { configId: "cfg", mode: "maybe" })).toMatchObject({ ok: false });
    expect(c.rpc).not.toHaveBeenCalled();
  });
});
