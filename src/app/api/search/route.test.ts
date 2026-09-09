import { beforeEach, describe, expect, it, vi } from "vitest";
const { getUser, rpc, reportError } = vi.hoisted(() => ({ getUser: vi.fn(), rpc: vi.fn(), reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser }, rpc }) }));
vi.mock("@/lib/errors/report", () => ({ reportError }));
import { GET } from "./route";
const request = (q = "sunflower") => new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`);
beforeEach(() => { vi.clearAllMocks(); getUser.mockResolvedValue({ data: { user: { id: "user" } } }); rpc.mockResolvedValue({ data: [], error: null }); });
describe("global search route", () => {
  it("requires authentication", async () => { getUser.mockResolvedValue({ data: { user: null } }); expect((await GET(request())).status).toBe(401); expect(rpc).not.toHaveBeenCalled(); });
  it("guards short trimmed queries and disables caching", async () => { const response = await GET(request(" ab ")); expect(await response.json()).toEqual({ results: [] }); expect(response.headers.get("cache-control")).toBe("no-store"); expect(rpc).not.toHaveBeenCalled(); });
  it("trims and caps the query", async () => { await GET(request(`  ${"a".repeat(110)}  `)); expect(rpc).toHaveBeenCalledWith("search_global", { q: "a".repeat(100), per_type: 5 }); });
  it("reports a missing RPC once and degrades", async () => { rpc.mockResolvedValue({ error: { code: "PGRST202" } }); const response = await GET(request()); expect(response.status).toBe(200); expect(await response.json()).toEqual({ results: [], degraded: true }); expect(reportError).toHaveBeenCalledTimes(1); });
  it("surfaces other database errors", async () => { rpc.mockResolvedValue({ error: { code: "42883" } }); const response = await GET(request()); expect(response.status).toBe(500); expect(await response.json()).toEqual({ ok: false, error: { code: "SEARCH_FAILED", message: "Search unavailable" } }); });
  it("retains sanitized database diagnostics without exposing query values", async () => {
    rpc.mockResolvedValue({ error: { code: "42883", message: 'function "private_fn" failed for sunflower\nhttps://secret.example/path' } });
    await GET(request());
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { surface: "global_search" },
      extra: { code: "42883", message: "function [redacted] failed for [query] [url]" },
    });
    const logged = JSON.stringify(reportError.mock.calls);
    expect(logged).not.toContain("sunflower");
    expect(logged).not.toContain("secret.example");
  });
  it("maps every destination including owners without a property", async () => {
    rpc.mockResolvedValue({ data: [
      { entity_type: "property", entity_id: "p" },
      { entity_type: "owner", entity_id: "o", property_id: "p" },
      { entity_type: "owner", entity_id: "o2", property_id: null, conversation_id: "c" },
      { entity_type: "thread", entity_id: "m", conversation_id: "c" },
    ].map(row => ({ ...row, title: "Title", subtitle: "Subtitle", matched_field: "phone" })), error: null });
    const { results } = await (await GET(request())).json();
    expect(results.map((r: { key: string; href: string }) => [r.key, r.href])).toEqual([
      ["property-p", "/leads/p"], ["owner-o", "/leads/p"], ["owner-o2", "/messages?thread=c"], ["thread-c", "/messages?thread=c"],
    ]);
    expect(results[0]).toMatchObject({ title: "Title", subtitle: "Subtitle", matchedField: "phone" });
  });
});
