import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "@/lib/errors/classes";

const ENV_KEYS = [
  "MESSAGING_PROVIDER",
  "DIALPAD_API_KEY",
  "DIALPAD_FROM_NUMBER",
  "DIALPAD_WEBHOOK_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_FROM_NUMBER",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.restoreAllMocks();
});

describe("getMessagingProvider — sync paths (dialpad, mock, off)", () => {
  it("returns null when MESSAGING_PROVIDER is unset", async () => {
    const { getMessagingProvider } = await import("./registry");
    expect(await getMessagingProvider()).toBeNull();
  });

  it("returns the mock provider when MESSAGING_PROVIDER=mock", async () => {
    process.env.MESSAGING_PROVIDER = "mock";
    const { getMessagingProvider } = await import("./registry");
    const p = await getMessagingProvider();
    expect(p?.providerId).toBe("mock");
  });

  it("returns the dialpad provider when MESSAGING_PROVIDER=dialpad and creds present", async () => {
    process.env.MESSAGING_PROVIDER = "dialpad";
    process.env.DIALPAD_API_KEY = "key";
    process.env.DIALPAD_FROM_NUMBER = "+18165550000";
    process.env.DIALPAD_WEBHOOK_SECRET = "secret";
    const { getMessagingProvider } = await import("./registry");
    const p = await getMessagingProvider();
    expect(p?.providerId).toBe("dialpad");
  });

  it("throws ConfigurationError on unknown provider value", async () => {
    process.env.MESSAGING_PROVIDER = "carrier-pigeon";
    const { getMessagingProvider } = await import("./registry");
    // Structural check rather than instanceof — vi.resetModules() creates
    // a fresh ConfigurationError class instance via the registry's
    // transitive import, which is a different identity than the one
    // imported at this test file's top level.
    await expect(getMessagingProvider()).rejects.toMatchObject({
      errorClass: "configuration",
      message: expect.stringContaining("Unknown MESSAGING_PROVIDER"),
    });
  });
});

/**
 * Regression: PR #130 introduced a static import of `./providers/twilio`
 * in registry.ts. That pulled twilio.ts + twilio-receiver.ts into the
 * import graph of every cockpit-page consumer, which is suspected of
 * contributing to E2E flake on cold-compile. Fixed by switching to a
 * dynamic import inside the "twilio" case.
 *
 * This test guards the fix: when MESSAGING_PROVIDER is dialpad or unset
 * (the only values used in CI + prod today), the twilio module must NOT
 * be loaded. Implementation detail check, but a cheap one — and the
 * cost of regressing is real.
 */
describe("getMessagingProvider — twilio is lazy-loaded", () => {
  it("does not load ./providers/twilio when MESSAGING_PROVIDER=dialpad", async () => {
    let twilioModuleLoaded = false;
    vi.doMock("./providers/twilio", () => {
      twilioModuleLoaded = true;
      return {
        twilioFromEnv: () => {
          throw new Error("twilioFromEnv should not be called in dialpad mode");
        },
      };
    });

    process.env.MESSAGING_PROVIDER = "dialpad";
    process.env.DIALPAD_API_KEY = "key";
    process.env.DIALPAD_FROM_NUMBER = "+18165550000";
    process.env.DIALPAD_WEBHOOK_SECRET = "secret";

    const { getMessagingProvider } = await import("./registry");
    await getMessagingProvider();

    expect(twilioModuleLoaded).toBe(false);
  });

  it("does not load ./providers/twilio when MESSAGING_PROVIDER is unset", async () => {
    let twilioModuleLoaded = false;
    vi.doMock("./providers/twilio", () => {
      twilioModuleLoaded = true;
      return {
        twilioFromEnv: () => {
          throw new Error("twilioFromEnv should not be called when off");
        },
      };
    });

    const { getMessagingProvider } = await import("./registry");
    await getMessagingProvider();

    expect(twilioModuleLoaded).toBe(false);
  });

  it("does load ./providers/twilio when MESSAGING_PROVIDER=twilio", async () => {
    let twilioModuleLoaded = false;
    vi.doMock("./providers/twilio", () => {
      twilioModuleLoaded = true;
      return {
        twilioFromEnv: () => ({ providerId: "twilio" }),
      };
    });

    process.env.MESSAGING_PROVIDER = "twilio";

    const { getMessagingProvider } = await import("./registry");
    const p = await getMessagingProvider();

    expect(twilioModuleLoaded).toBe(true);
    expect(p?.providerId).toBe("twilio");
  });
});
