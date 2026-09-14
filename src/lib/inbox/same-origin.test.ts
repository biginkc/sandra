import { afterEach, expect, it, vi } from "vitest";
import { isInboxSameOrigin } from "./same-origin";
afterEach(() => vi.unstubAllEnvs());
const request = (headers: Record<string, string>) => new Request("http://localhost:52582/api/inbox/worksets", { headers });
it("accepts the real browser authority despite Next's internal hostname", () => {
  expect(isInboxSameOrigin(request({ origin: "http://127.0.0.1:52582", host: "127.0.0.1:52582" }))).toBe(true);
});
it.each(["", "foreign.example", "127.0.0.1:52582,foreign.example", "user@127.0.0.1:52582", "127.0.0.1:52582/path", "127.0.0.1:52582?x", "127.0.0.1:52582#x"])("rejects foreign or malformed host %s", host => {
  expect(isInboxSameOrigin(request({ origin: "http://127.0.0.1:52582", host }))).toBe(false);
});
it.each(["null", "https://127.0.0.1:52582", "http://127.0.0.1:52582/path", "http://127.0.0.1:52582/"])("rejects invalid or different origin %s", origin => {
  expect(isInboxSameOrigin(request({ origin, host: "127.0.0.1:52582" }))).toBe(false);
});
it("ignores forwarded hosts and rejects explicit cross-site navigation", () => {
  expect(isInboxSameOrigin(request({ origin: "http://foreign.example", "x-forwarded-host": "foreign.example" }))).toBe(false);
  expect(isInboxSameOrigin(request({ origin: "http://127.0.0.1:52582", host: "127.0.0.1:52582", "sec-fetch-site": "cross-site" }))).toBe(false);
});
it("retains no-origin API clients and URL authority when Host is absent", () => {
  expect(isInboxSameOrigin(request({}))).toBe(true);
  expect(isInboxSameOrigin(request({ origin: "http://localhost:52582" }))).toBe(true);
});
it("rejects a forged Host that agrees with a foreign Origin but isn't the app's trusted origin", () => {
  expect(isInboxSameOrigin(request({ origin: "http://evil.test", host: "evil.test" }))).toBe(false);
});
it("accepts Sec-Fetch-Site: same-origin even when Host doesn't match the configured app origin (e.g. a Vercel preview host)", () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://sandra.bmhgroupkc.com");
  expect(isInboxSameOrigin(request({
    origin: "https://my-branch-abc123.vercel.app",
    host: "my-branch-abc123.vercel.app",
    "sec-fetch-site": "same-origin",
  }))).toBe(true);
});
it("rejects a localhost origin in production when Sec-Fetch-Site doesn't vouch for it", () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(isInboxSameOrigin(request({ origin: "http://localhost:52582", host: "localhost:52582" }))).toBe(false);
});
it("accepts an Origin matching the configured app origin in production without Sec-Fetch-Site", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://sandra.example");
  expect(isInboxSameOrigin(request({ origin: "http://sandra.example", host: "sandra.example" }))).toBe(true);
});
