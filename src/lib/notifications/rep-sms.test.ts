import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

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
    // Codex round 7 (finding 1, item 5): the deadline AbortSignal is now
    // forwarded as a second arg (undefined when the caller doesn't pass
    // one, as here).
    expect(mocks.sendSms).toHaveBeenCalledWith(
      {
        to: "+18165551234",
        body: "Appointment in 30 min",
        from: "+18165550000",
      },
      { signal: undefined },
    );
    expect(result).toEqual({ ok: true, externalId: "sms-ext-1" });
  });

  it("forwards a caller-supplied AbortSignal through to the provider (Codex round 7, finding 1, item 5)", async () => {
    const controller = new AbortController();

    await sendRepSmsReminder({
      to: "+18165551234",
      body: "Appointment in 30 min",
      signal: controller.signal,
    });

    expect(mocks.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+18165551234" }),
      { signal: controller.signal },
    );
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

  // Codex round 8: a deadline AbortSignal firing mid-call cannot prove
  // non-delivery — the fetch was torn down, not the send. Must surface as
  // its own "aborted_ambiguous" reason, never the ordinary "provider_error"
  // a real Sendillo rejection carries (which downstream code treats as a
  // safe-to-retry confirmed failure).
  it("returns aborted_ambiguous (not provider_error) when sendSms rejects with an AbortError while the deadline signal is already aborted", async () => {
    const controller = new AbortController();
    mocks.sendSms.mockImplementationOnce(async () => {
      controller.abort();
      const abortError = new Error("This operation was aborted");
      abortError.name = "AbortError";
      throw abortError;
    });

    const result = await sendRepSmsReminder({
      to: "+18165551234",
      body: "Appointment in 30 min",
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: false,
      reason: "aborted_ambiguous",
      message: "This operation was aborted",
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "rep_sms_send_aborted_ambiguous" } }),
    );
  });

  it("also detects the abort by signal.aborted at catch time when the rejection itself doesn't carry the AbortError name (e.g. sendillo.ts's ProviderError re-wrap)", async () => {
    const controller = new AbortController();
    mocks.sendSms.mockImplementationOnce(async () => {
      controller.abort();
      // Simulates SendilloMessagingProvider.sendSms's real behavior: it
      // catches the raw fetch AbortError and re-throws a ProviderError,
      // whose `name` is "ProviderError", not "AbortError" — so detection
      // must fall back to the signal itself.
      throw new Error("fetch failed: aborted");
    });

    const result = await sendRepSmsReminder({
      to: "+18165551234",
      body: "Appointment in 30 min",
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: false,
      reason: "aborted_ambiguous",
      message: "fetch failed: aborted",
    });
  });

  it("maps a Sendillo 503 (details.ambiguousDelivery) to aborted_ambiguous — a 5xx cannot prove non-delivery (Codex round 13)", async () => {
    mocks.sendSms.mockRejectedValueOnce(
      new ProviderError("Sendillo 503: upstream unavailable", "sendillo", {
        status: 503,
        ambiguousDelivery: true,
      }),
    );

    const result = await sendRepSmsReminder({
      to: "+18165551234",
      body: "Appointment in 30 min",
    });

    expect(result).toEqual({
      ok: false,
      reason: "aborted_ambiguous",
      message: "Sendillo 503: upstream unavailable",
    });
  });

  // Codex round 9 (finding 1): sendillo.ts's own internal
  // DEFAULT_SEND_TIMEOUT_MS can fire and abort the underlying fetch BEFORE
  // the caller's own deadline signal does — the caller's signal is still
  // live (never aborted) at catch time here, so detection can't rely on
  // `params.signal?.aborted`. Must still classify as aborted_ambiguous via
  // the `ProviderError.details.isAbort` flag sendillo.ts now sets.
  it("returns aborted_ambiguous when the provider's own internal timeout fires while the caller's deadline signal is still live", async () => {
    const controller = new AbortController();
    mocks.sendSms.mockRejectedValueOnce(
      new ProviderError("This operation was aborted", "sendillo", { isAbort: true }),
    );

    const result = await sendRepSmsReminder({
      to: "+18165551234",
      body: "Appointment in 30 min",
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(false);
    expect(result).toEqual({
      ok: false,
      reason: "aborted_ambiguous",
      message: "This operation was aborted",
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "rep_sms_send_aborted_ambiguous" } }),
    );
  });

  // Codex round 12 (finding 1): a non-abort transport failure (connection
  // reset mid-flight, no HTTP response ever received) proves nothing about
  // delivery — same never-retryable posture as an abort.
  it("returns aborted_ambiguous when sendillo.ts reports a non-abort transport failure mid-flight (e.g. connection reset)", async () => {
    mocks.sendSms.mockRejectedValueOnce(
      new ProviderError("getaddrinfo ENOTFOUND www.sendillo.com", "sendillo", {
        transportFailure: true,
      }),
    );

    const result = await sendRepSmsReminder({
      to: "+18165551234",
      body: "Appointment in 30 min",
    });

    expect(result).toEqual({
      ok: false,
      reason: "aborted_ambiguous",
      message: "getaddrinfo ENOTFOUND www.sendillo.com",
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "rep_sms_send_aborted_ambiguous" } }),
    );
  });

  // Codex round 12 (finding 1): a 2xx with no reconcilable message id was
  // definitely received by Sendillo, but can't be confirmed durably —
  // same never-retryable posture as an abort or a transport failure.
  it("returns aborted_ambiguous when sendillo.ts reports a 2xx response with no reconcilable message id", async () => {
    mocks.sendSms.mockRejectedValueOnce(
      new ProviderError("Sendillo send succeeded but response had no messageId", "sendillo", {
        acceptedWithoutId: true,
      }),
    );

    const result = await sendRepSmsReminder({
      to: "+18165551234",
      body: "Appointment in 30 min",
    });

    expect(result).toEqual({
      ok: false,
      reason: "aborted_ambiguous",
      message: "Sendillo send succeeded but response had no messageId",
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "rep_sms_send_aborted_ambiguous" } }),
    );
  });

  // Codex round 10 (finding 4): sendillo.ts throws with `details.notSent =
  // true` specifically when the caller's deadline signal was ALREADY
  // aborted before any fetch was attempted — a strictly stronger guarantee
  // than the mid-flight/internal-timeout aborts above (no request ever left
  // the process). Must classify as its OWN `not_sent` reason, never folded
  // into `aborted_ambiguous` — even though `params.signal?.aborted` is true
  // here too, which would otherwise satisfy the generic `aborted` check.
  it("returns not_sent (not aborted_ambiguous) when sendillo.ts reports the signal was already aborted before any fetch was attempted", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.sendSms.mockRejectedValueOnce(
      new ProviderError("Sendillo send not attempted: deadline signal was already aborted", "sendillo", {
        isAbort: true,
        notSent: true,
      }),
    );

    const result = await sendRepSmsReminder({
      to: "+18165551234",
      body: "Appointment in 30 min",
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: false,
      reason: "not_sent",
      message: "Sendillo send not attempted: deadline signal was already aborted",
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "rep_sms_send_not_sent" } }),
    );
  });

  it("still returns provider_error when sendSms rejects and the signal was never aborted (a genuine provider failure, unrelated to any deadline)", async () => {
    const controller = new AbortController();
    mocks.sendSms.mockRejectedValueOnce(new Error("Sendillo 500"));

    const result = await sendRepSmsReminder({
      to: "+18165551234",
      body: "Appointment in 30 min",
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, reason: "provider_error", message: "Sendillo 500" });
  });
});
