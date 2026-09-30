import { afterEach, expect, it, vi } from "vitest";
import { dynamic, GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

it("returns only deployment identity with no-store", async () => {
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
  vi.stubEnv("SENDILLO_API_KEY", "never-in-body");
  const response = await GET();
  expect(dynamic).toBe("force-dynamic");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ deploymentId: "dpl_test", commitSha: "a".repeat(40) });
  expect(body).not.toContain("never-in-body");
});
