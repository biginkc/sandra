import { afterAll, expect } from "vitest";

const originalFetch = globalThis.fetch;
let rejected = 0;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== "http://127.0.0.1:54321") {
    rejected++;
    throw new Error("Disposable canary attempted an external fetch");
  }
  return originalFetch(input, { ...init, redirect: "error" });
};
afterAll(() => {
  globalThis.fetch = originalFetch;
  expect(rejected, "External fetches must not occur, including caught errors").toBe(0);
});
