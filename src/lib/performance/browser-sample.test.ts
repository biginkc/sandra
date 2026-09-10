import { expect, it } from "vitest";
import { parseBrowserSample } from "./browser-sample";
it("allowlists performance values and strips content, URLs and client timestamps", () => {
  expect(parseBrowserSample({ flow: "messages.selection", stage: "usable_dom", outcome: "failed", durationMs: 1200.123,
    body: "secret", url: "secret", at: "secret", traceId: "secret" })).toEqual({ flow: "messages.selection", stage: "usable_dom", outcome: "failed", durationMs: 1200.1 });
});
it("rejects unbounded or invalid measurements", () => {
  for (const durationMs of [-1, Infinity, NaN, 300001, "100"]) expect(parseBrowserSample({ flow: "leads.page", stage: "usable_dom", outcome: "completed", durationMs })).toBeNull();
  expect(parseBrowserSample({ flow: "customer-name", stage: "usable_dom", outcome: "completed", durationMs: 1 })).toBeNull();
});
