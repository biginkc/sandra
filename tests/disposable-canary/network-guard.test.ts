import { describe, expect, it, vi } from "vitest";

import {
  DISPOSABLE_CANARY_API_ORIGIN,
  installDisposableCanaryNetworkGuard,
} from "./network-guard";

describe("disposable canary egress guard", () => {
  it("rejects a provider URL before the underlying network call", () => {
    const underlyingFetch = vi.fn<typeof fetch>();
    const guardedFetch = installDisposableCanaryNetworkGuard(underlyingFetch);

    expect(() =>
      guardedFetch("https://api.sendillo.com/v1/messages", {
        method: "POST",
      }),
    ).toThrow("Disposable canary attempted an external fetch");
    expect(underlyingFetch).not.toHaveBeenCalled();

    // Also exercise the setup-installed process guard, whose underlying
    // implementation is the real fetch and therefore must never be reached.
    expect(() => globalThis.fetch("https://api.sendillo.com/v1/messages")).toThrow(
      "Disposable canary attempted an external fetch",
    );
  });

  it("continues to permit the runner-owned loopback API", async () => {
    const underlyingFetch = vi.fn<typeof fetch>(
      async () => new Response("ok", { status: 200 }),
    );
    const guardedFetch = installDisposableCanaryNetworkGuard(underlyingFetch);

    const response = await guardedFetch(`${DISPOSABLE_CANARY_API_ORIGIN}/rest/v1/health`);

    expect(response.status).toBe(200);
    expect(underlyingFetch).toHaveBeenCalledOnce();
    expect(underlyingFetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
    });
  });
});
