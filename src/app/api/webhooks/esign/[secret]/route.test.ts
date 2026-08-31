import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDependencies: vi.fn(() => ({ marker: "dependencies" })),
  handleWebhook: vi.fn(async () => new Response("Hello API Event Received")),
}));

vi.mock("@/lib/esign/webhook-server", () => ({
  createConcreteDropboxSignWebhookDependencies: mocks.createDependencies,
}));
vi.mock("@/lib/esign/webhook-handler", () => ({
  handleDropboxSignWebhook: mocks.handleWebhook,
}));

import { POST, runtime } from "./route";

describe("public Dropbox Sign webhook route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses Node.js and forwards the path secret into the isolated handler", async () => {
    const request = new Request(
      "https://sandra.test/api/webhooks/esign/path-secret",
      { method: "POST" },
    );
    const response = await POST(request, {
      params: Promise.resolve({ secret: "path-secret" }),
    });

    expect(runtime).toBe("nodejs");
    expect(mocks.createDependencies).toHaveBeenCalledOnce();
    expect(mocks.handleWebhook).toHaveBeenCalledWith({
      request,
      pathSecret: "path-secret",
      dependencies: { marker: "dependencies" },
    });
    expect(await response.text()).toBe("Hello API Event Received");
  });
});
