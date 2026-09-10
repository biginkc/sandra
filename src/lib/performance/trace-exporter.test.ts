import { afterEach, expect, it, vi } from "vitest";
import { classifySupabaseRequest } from "./server-timing";
import { performanceExporter } from "./trace-exporter";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("classifies known routes without retaining customer IDs, filters, or credentials", () => {
  expect(classifySupabaseRequest("https://db.test/rest/v1/messages?body=eq.secret&apikey=credential")).toBe("messages");
  expect(classifySupabaseRequest("https://db.test/auth/v1/admin/users/customer-id")).toBe("auth.identity");
  expect(classifySupabaseRequest("https://db.test/private/customer-name")).toBe("other");
});

it("drops automatic spans, attributes, events, and unsafe environment values", () => {
  vi.stubEnv("SANDRA_PERFORMANCE_TELEMETRY", "1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "secret");
  vi.stubEnv("VERCEL_REGION", "secret");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const done = vi.fn();
  const span = {
    name: "messages.detail", instrumentationScope: { name: "sandra.performance" },
    attributes: { "sandra.resource": "messages", "sandra.http_status": 200, "url.full": "secret", "sandra.untrusted": "secret" },
    events: [{ name: "secret exception" }], resource: { attributes: { secret: "secret" } },
    duration: [1, 500000000], startTime: [1700000000, 0], status: { code: 0 },
    spanContext: () => ({ traceId: "trace", spanId: "span" }),
  };
  performanceExporter.export([
    span, { ...span, name: "GET /customer-name?secret" },
    { ...span, instrumentationScope: { name: "automatic" } },
  ] as never, done);
  expect(log).toHaveBeenCalledTimes(1);
  const output = log.mock.calls[0][0] as string;
  expect(output).not.toContain("secret");
  expect(JSON.parse(output)).toMatchObject({ durationMs: 1500, deployment: "local", region: "unknown", "sandra.resource": "messages" });
  expect(done).toHaveBeenCalledWith({ code: 0 });
});

it("is disabled unless explicitly enabled", () => {
  vi.stubEnv("SANDRA_PERFORMANCE_TELEMETRY", "0");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const done = vi.fn();
  performanceExporter.export([] as never, done);
  expect(log).not.toHaveBeenCalled();
  expect(done).toHaveBeenCalledWith({ code: 0 });
});
