import { describe, expect, it, vi } from "vitest";

import {
  loadOfficialEmbeddedTemplateClient,
  mountEmbeddedTemplateClient,
  shouldSkipDomainVerification,
  type EmbeddedTemplateClient,
} from "./embedded-template-client";

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  officialClient: {
    on: vi.fn(),
    off: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("hellosign-embedded", () => ({
  default: class HelloSign {
    constructor(options: { clientId: string }) {
      mocks.constructor(options);
      return mocks.officialClient;
    }
  },
}));

describe("mountEmbeddedTemplateClient", () => {
  it("registers terminal/error listeners before opening and cleans up", () => {
    const calls: string[] = [];
    const listeners = new Map<string, (payload: never) => void>();
    const client: EmbeddedTemplateClient = {
      on: vi.fn((event, listener) => { calls.push(`on:${event}`); listeners.set(event, listener as never); }),
      off: vi.fn((event) => { calls.push(`off:${event}`); }),
      open: vi.fn(() => { calls.push("open"); }),
      close: vi.fn(() => { calls.push("close"); }),
    };
    const cleanup = mountEmbeddedTemplateClient({
      client,
      session: { providerTemplateId: "provider-1", editUrl: "https://edit", expiresAt: 123, clientId: "client-1" },
      container: {} as HTMLElement,
      skipDomainVerification: false,
      listeners: { onFinish: vi.fn(), onCancel: vi.fn(), onClose: vi.fn(), onError: vi.fn() },
    });
    expect(calls.slice(0, 5)).toEqual(["on:finish", "on:cancel", "on:close", "on:error", "open"]);
    cleanup();
    expect(calls.at(-1)).toBe("close");
    cleanup();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("dynamically constructs the official browser client with the session client ID", async () => {
    await expect(loadOfficialEmbeddedTemplateClient("client-1")).resolves.toBe(mocks.officialClient);
    expect(mocks.constructor).toHaveBeenCalledWith({ clientId: "client-1" });
  });

  it("skips domain verification only for localhost and preview deployments", () => {
    expect(shouldSkipDomainVerification({ hostname: "localhost" })).toBe(true);
    expect(shouldSkipDomainVerification({ hostname: "127.0.0.1" })).toBe(true);
    expect(shouldSkipDomainVerification({ hostname: "branch.sandra.test", deploymentEnvironment: "preview" })).toBe(true);
    expect(shouldSkipDomainVerification({ hostname: "app.sandra.com", deploymentEnvironment: "production" })).toBe(false);
    expect(shouldSkipDomainVerification({ hostname: "branch.vercel.app" })).toBe(false);
  });
});
