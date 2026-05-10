import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("getMessagingProvider", () => {
  it("returns null when messaging is off", async () => {
    const { getMessagingProvider } = await import("./registry");

    await expect(getMessagingProvider()).resolves.toBeNull();
  });

  it("returns the mock provider when MESSAGING_PROVIDER=mock", async () => {
    process.env.MESSAGING_PROVIDER = "mock";
    const { getMessagingProvider } = await import("./registry");

    await expect(getMessagingProvider()).resolves.toMatchObject({
      providerId: "mock",
    });
  });

  it("returns the dialpad provider without loading the twilio provider", async () => {
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
    const provider = await getMessagingProvider();

    expect(provider?.providerId).toBe("dialpad");
    expect(twilioModuleLoaded).toBe(false);
  });

  it("does not load the twilio provider when messaging is off", async () => {
    let twilioModuleLoaded = false;
    vi.doMock("./providers/twilio", () => {
      twilioModuleLoaded = true;
      return {
        twilioFromEnv: () => {
          throw new Error("twilioFromEnv should not be called when messaging is off");
        },
      };
    });

    const { getMessagingProvider } = await import("./registry");
    await getMessagingProvider();

    expect(twilioModuleLoaded).toBe(false);
  });

  it("loads the twilio provider only when MESSAGING_PROVIDER=twilio", async () => {
    let twilioModuleLoaded = false;
    vi.doMock("./providers/twilio", () => {
      twilioModuleLoaded = true;
      return {
        twilioFromEnv: () => ({ providerId: "twilio" }),
      };
    });

    process.env.MESSAGING_PROVIDER = "twilio";

    const { getMessagingProvider } = await import("./registry");
    const provider = await getMessagingProvider();

    expect(twilioModuleLoaded).toBe(true);
    expect(provider?.providerId).toBe("twilio");
  });

  it("throws a configuration error on an unknown provider", async () => {
    process.env.MESSAGING_PROVIDER = "unknown";
    const { getMessagingProvider } = await import("./registry");

    await expect(getMessagingProvider()).rejects.toMatchObject({
      errorClass: "configuration",
      message: expect.stringContaining("Unknown MESSAGING_PROVIDER"),
    });
  });
});
