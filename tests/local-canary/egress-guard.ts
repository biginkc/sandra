import { afterAll, expect } from "vitest";

const fetchLocal = globalThis.fetch;
let rejected = 0;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "54321"
  ) {
    rejected += 1;
    throw new Error("Local canary proof attempted external HTTP");
  }
  return fetchLocal(input, init);
};
afterAll(() => {
  globalThis.fetch = fetchLocal;
  expect(
    rejected,
    "No external HTTP, including caught failures, is permitted",
  ).toBe(0);
});
