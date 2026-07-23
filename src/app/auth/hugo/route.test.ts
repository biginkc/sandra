import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { startHugoSignIn } = vi.hoisted(() => ({ startHugoSignIn: vi.fn() }));
vi.mock("@/lib/auth/start-hugo", () => ({ startHugoSignIn }));

import { GET } from "./route";

describe("GET /auth/hugo", () => {
  it("starts Hugo from a stable URL and redirects to its authorization URL", async () => {
    startHugoSignIn.mockResolvedValue({
      ok: true,
      authUrl: "https://hugo.test/authorize",
    });
    const response = await GET(
      new NextRequest("https://sandra.test/auth/hugo?next=%2Fleads%2F5"),
    );
    expect(startHugoSignIn).toHaveBeenCalledWith(
      "https://sandra.test",
      "/leads/5",
    );
    expect(response.headers.get("location")).toBe("https://hugo.test/authorize");
  });

  it("preserves only the helper's sanitized next on failure", async () => {
    startHugoSignIn.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      next: "/leads/5",
    });
    const response = await GET(
      new NextRequest("https://sandra.test/auth/hugo?next=%2F%2Fevil.test"),
    );
    expect(response.headers.get("location")).toBe(
      "https://sandra.test/login?error=sso&next=%2Fleads%2F5",
    );
  });
});
