import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPurchasedNumbers: vi.fn(),
  sendSms: vi.fn(),
  reportError: vi.fn(),
  constructorSpy: vi.fn(),
}));

vi.mock("@/lib/messaging/providers/sendillo", () => ({
  SendilloMessagingProvider: class {
    constructor(apiKey: string, fromNumber: string) {
      mocks.constructorSpy(apiKey, fromNumber);
    }
    listPurchasedNumbers = mocks.listPurchasedNumbers;
    sendSms = mocks.sendSms;
  },
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import {
  __resetRepSmsCatalogCacheForTests,
  checkRepSmsFromNumberReady,
  sendRepSmsReminder,
} from "./rep-sms";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  __resetRepSmsCatalogCacheForTests();
  process.env.SENDILLO_API_KEY = "test-key";
  process.env.REP_SMS_FROM_NUMBER = "+18165550000";
  mocks.listPurchasedNumbers.mockResolvedValue([
    { phoneE164: "+18165550000", providerNumberId: "num-1", status: "active", messagingStatus: null, raw: {} },
  ]);
  mocks.sendSms.mockResolvedValue({ externalId: "sms-ext-1", providerStatus: "accepted", raw: {} });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("checkRepSmsFromNumberReady", () => {
  it("fails closed when REP_SMS_FROM_NUMBER is unset", async () => {
    delete process.env.REP_SMS_FROM_NUMBER;

    const result = await checkRepSmsFromNumberReady();

    expect(result).toEqual({
      ready: false,
      reason: "not_configured",
      message: expect.stringContaining("REP_SMS_FROM_NUMBER"),
    });
    expect(mocks.listPurchasedNumbers).not.toHaveBeenCalled();
  });

  it("fails closed when SENDILLO_API_KEY is unset", async () => {
    delete process.env.SENDILLO_API_KEY;

    const result = await checkRepSmsFromNumberReady();

    expect(result.ready).toBe(false);
  });

  it("fails closed when the configured number is not in the purchased-number catalog", async () => {
    mocks.listPurchasedNumbers.mockResolvedValueOnce([
      { phoneE164: "+18165559999", providerNumberId: "num-2", status: "active", messagingStatus: null, raw: {} },
    ]);

    const result = await checkRepSmsFromNumberReady();

    expect(result).toEqual({
      ready: false,
      reason: "number_not_in_catalog",
      message: expect.stringContaining("+18165550000"),
    });
  });

  it("is ready when env is set and the number is in the catalog", async () => {
    await expect(checkRepSmsFromNumberReady()).resolves.toEqual({ ready: true });
  });

  it("fails closed (not throws) when the catalog fetch itself errors", async () => {
    mocks.listPurchasedNumbers.mockRejectedValueOnce(new Error("Sendillo 500"));

    const result = await checkRepSmsFromNumberReady();

    expect(result.ready).toBe(false);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "rep_sms_catalog_check" } }),
    );
  });

  it("caches the catalog call across repeated checks", async () => {
    await checkRepSmsFromNumberReady();
    await checkRepSmsFromNumberReady();
    await checkRepSmsFromNumberReady();

    expect(mocks.listPurchasedNumbers).toHaveBeenCalledTimes(1);
  });
});

describe("sendRepSmsReminder", () => {
  it("sends through SendilloMessagingProvider with the rep from-number and returns the provider message id", async () => {
    const result = await sendRepSmsReminder({ to: "+18165551234", body: "Appointment in 30 min" });

    expect(mocks.constructorSpy).toHaveBeenCalledWith("test-key", "+18165550000");
    expect(mocks.sendSms).toHaveBeenCalledWith({
      to: "+18165551234",
      body: "Appointment in 30 min",
      from: "+18165550000",
    });
    expect(result).toEqual({ ok: true, externalId: "sms-ext-1" });
  });

  it("fails closed without calling the provider when env is missing", async () => {
    delete process.env.REP_SMS_FROM_NUMBER;

    const result = await sendRepSmsReminder({ to: "+18165551234", body: "Appointment in 30 min" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("fails closed without calling the provider when the number is not in the catalog", async () => {
    mocks.listPurchasedNumbers.mockResolvedValueOnce([]);

    const result = await sendRepSmsReminder({ to: "+18165551234", body: "Appointment in 30 min" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("number_not_in_catalog");
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("reports and returns provider_error when sendSms rejects", async () => {
    mocks.sendSms.mockRejectedValueOnce(new Error("Sendillo 500"));

    const result = await sendRepSmsReminder({ to: "+18165551234", body: "Appointment in 30 min" });

    expect(result).toEqual({ ok: false, reason: "provider_error", message: "Sendillo 500" });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "rep_sms_send" } }),
    );
  });
});
