import { describe, expect, it, vi } from "vitest";

import { mountEmbeddedTemplateClient, type EmbeddedTemplateClient } from "./embedded-template-client";

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
      session: { providerTemplateId: "provider-1", editUrl: "https://edit", expiresAt: 123, clientId: "client-1", skipDomainVerification: false },
      container: {} as HTMLElement,
      listeners: { onFinish: vi.fn(), onCancel: vi.fn(), onClose: vi.fn(), onError: vi.fn() },
    });
    expect(calls.slice(0, 5)).toEqual(["on:finish", "on:cancel", "on:close", "on:error", "open"]);
    cleanup();
    expect(calls.at(-1)).toBe("close");
  });
});
