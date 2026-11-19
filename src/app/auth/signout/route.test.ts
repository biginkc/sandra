import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
const { signOut } = vi.hoisted(() => ({ signOut: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signOut } }) }));
import { POST } from "./route";
it("signs out only this session and clears its provider proof", async () => {
  const response = await POST(new NextRequest("https://sandra.test/auth/signout", { method: "POST" }));
  expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(response.status).toBe(303);
  expect(response.cookies.get("__Host-sandra-hugo-session")?.maxAge).toBe(0);
});
