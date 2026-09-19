export const DISPOSABLE_CANARY_API_ORIGIN = "http://127.0.0.1:54321";

type FetchLike = typeof globalThis.fetch;

/**
 * Build an egress guard around a fetch implementation. Keeping installation
 * separate makes the denial contract testable with a spy and avoids a suite
 * lifecycle hook that restores `fetch` underneath another test.
 */
export function installDisposableCanaryNetworkGuard(
  fetchImpl: FetchLike,
): FetchLike {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.origin !== DISPOSABLE_CANARY_API_ORIGIN) {
      throw new Error("Disposable canary attempted an external fetch");
    }
    return fetchImpl(input, { ...init, redirect: "error" });
  }) as FetchLike;
}

// The guard remains installed for the whole Vitest process. It intentionally
// has no afterAll restoration: restoring a global at suite teardown can race
// with an in-flight legitimate local request in another test worker.
globalThis.fetch = installDisposableCanaryNetworkGuard(globalThis.fetch);
