import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

import { SendilloMessagingProvider, sendilloFromEnv } from "./providers/sendillo";
import { TwilioMessagingProvider } from "./providers/twilio";
import { DialpadMessagingProvider } from "./providers/dialpad";
import { getMessagingProvider, getWebhookProvider } from "./registry";
import {
  ReplayStubError,
  getReplayHandshake,
  isReplayStubEnabled,
  setReplayOutboundRecorder,
} from "./replay-stub";

const ENV_KEYS = [
  "SMS_PROVIDER_STUB",
  "MESSAGING_PROVIDER",
  "SENDILLO_API_KEY",
  "SENDILLO_FROM_NUMBER",
  "SENDILLO_WEBHOOK_SECRET",
  "REPLAY_BATCH_ID",
  "AI_RESPONDER_LLM_AUTOSEND",
  "NEXT_PUBLIC_SUPABASE_URL",
] as const;
const saved: Record<string, string | undefined> = {};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fetchSpy = vi.fn(async () => {
    throw new Error("network must not be reached");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setReplayOutboundRecorder(null);
  vi.unstubAllGlobals();
});

describe("isReplayStubEnabled", () => {
  it("is on only for exactly '1'", () => {
    expect(isReplayStubEnabled()).toBe(false);
    for (const v of ["0", "true", "yes", " 1", ""]) {
      process.env.SMS_PROVIDER_STUB = v;
      expect(isReplayStubEnabled()).toBe(false);
    }
    process.env.SMS_PROVIDER_STUB = "1";
    expect(isReplayStubEnabled()).toBe(true);
  });
});

describe("real providers refuse the network under SMS_PROVIDER_STUB=1", () => {
  beforeEach(() => {
    process.env.SMS_PROVIDER_STUB = "1";
  });

  it("the real Sendillo sendSms throws and never calls fetch", async () => {
    const real = new SendilloMessagingProvider("key", "+18165550100");
    await expect(real.sendSms({ to: "+18165550123", body: "hi" })).rejects.toBeInstanceOf(ReplayStubError);
    await expect(real.sendSms({ to: "+18165550123", body: "hi" })).rejects.toBeInstanceOf(ProviderError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the real Sendillo catalog reads refuse too", async () => {
    const real = new SendilloMessagingProvider("key", "+18165550100");
    await expect(real.listPurchasedNumbers()).rejects.toBeInstanceOf(ReplayStubError);
    await expect(real.listProviderCampaigns()).rejects.toBeInstanceOf(ReplayStubError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Twilio and Dialpad sendSms refuse", async () => {
    const twilio = new TwilioMessagingProvider({ accountSid: "AC1", authToken: "tok", fromNumber: "+18165550100" });
    const dialpad = new DialpadMessagingProvider("k", "+18165550100", "s");
    await expect(twilio.sendSms({ to: "+18165550123", body: "hi" })).rejects.toBeInstanceOf(ReplayStubError);
    await expect(dialpad.sendSms({ to: "+18165550123", body: "hi" })).rejects.toBeInstanceOf(ReplayStubError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sendilloFromEnv returns a recording stub that needs no API key", async () => {
    process.env.SENDILLO_WEBHOOK_SECRET = "whsec-local";
    process.env.REPLAY_BATCH_ID = "2026-10-07";
    const recorded: unknown[] = [];
    setReplayOutboundRecorder(async (row) => {
      recorded.push(row);
    });
    const provider = sendilloFromEnv();
    const result = await provider.sendSms({ to: "+18165550123", body: "Hello there" });
    expect(result.externalId).toMatch(/^replay-stub-/);
    expect(result.providerStatus).toBe("accepted");
    expect(recorded).toEqual([
      expect.objectContaining({ provider: "sendillo", to: "+18165550123", body: "Hello there", batchId: "2026-10-07" }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // the stub still verifies the local webhook secret so the replay can post to the real route
    const headers = new Headers({ "x-sendillo-webhook-secret": "whsec-local" });
    expect(provider.verifyWebhookSignature("{}", headers)).toBe(true);
  });

  it("a recorder failure never sends and never throws", async () => {
    setReplayOutboundRecorder(async () => {
      throw new Error("db down");
    });
    const result = await sendilloFromEnv().sendSms({ to: "+18165550123", body: "x" });
    expect(result.externalId).toMatch(/^replay-stub-/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the registry refuses non-sendillo, non-mock providers", () => {
    for (const p of ["twilio", "dialpad"]) {
      process.env.MESSAGING_PROVIDER = p;
      expect(() => getMessagingProvider()).toThrow(ReplayStubError);
    }
    process.env.MESSAGING_PROVIDER = "sendillo";
    expect(getMessagingProvider()?.providerId).toBe("sendillo");
    process.env.MESSAGING_PROVIDER = "mock";
    expect(getMessagingProvider()?.providerId).toBe("mock");
  });

  it("webhook providers other than sendillo resolve to null", () => {
    expect(getWebhookProvider("twilio")).toBeNull();
    expect(getWebhookProvider("dialpad")).toBeNull();
    expect(getWebhookProvider("sendillo")?.providerId).toBe("sendillo");
  });
});

describe("without the flag nothing changes", () => {
  it("sendilloFromEnv still demands credentials", () => {
    expect(() => sendilloFromEnv()).toThrow(/credentials missing/i);
  });
});

describe("getReplayHandshake", () => {
  it("is null unless the stub is on", () => {
    expect(getReplayHandshake()).toBeNull();
  });
  it("reports the stub, key presence, autosend and supabase host", () => {
    process.env.SMS_PROVIDER_STUB = "1";
    process.env.AI_RESPONDER_LLM_AUTOSEND = "0";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54331";
    expect(getReplayHandshake()).toEqual({
      replayStub: true,
      sendilloApiKeyPresent: false,
      llmAutosend: "0",
      supabaseHost: "127.0.0.1:54331",
    });
    process.env.SENDILLO_API_KEY = "k";
    expect(getReplayHandshake()?.sendilloApiKeyPresent).toBe(true);
  });
});

describe("bulk reply transport", () => {
  it("cannot be constructed under the stub flag", async () => {
    const { createSendilloReplyTransport } = await import("@/lib/inbox/reply-provider");
    expect(() => createSendilloReplyTransport("key")).not.toThrow();
    process.env.SMS_PROVIDER_STUB = "1";
    expect(() => createSendilloReplyTransport("key")).toThrow(ReplayStubError);
  });
});
