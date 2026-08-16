import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "@/lib/errors/classes";

import {
  lineTypeFromTelnyxLabel,
  telnyxLookupFromEnv,
  TelnyxLineTypeLookup,
} from "./telnyx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function carrierBody(type: string | null, portabilityLineType?: string) {
  return {
    data: {
      carrier: { type },
      portability: portabilityLineType
        ? { line_type: portabilityLineType }
        : undefined,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("lineTypeFromTelnyxLabel", () => {
  it("maps Telnyx labels to our vocabulary (VoIP counts as mobile)", () => {
    expect(lineTypeFromTelnyxLabel("mobile")).toBe("mobile");
    expect(lineTypeFromTelnyxLabel("Wireless")).toBe("mobile");
    expect(lineTypeFromTelnyxLabel("voip")).toBe("mobile");
    expect(lineTypeFromTelnyxLabel("landline")).toBe("landline");
    expect(lineTypeFromTelnyxLabel("fixed line")).toBe("landline");
    expect(lineTypeFromTelnyxLabel("satellite")).toBe("unknown");
    expect(lineTypeFromTelnyxLabel(null)).toBe("unknown");
  });
});

describe("TelnyxLineTypeLookup.classify", () => {
  it("classifies each number from carrier.type, falling back to portability.line_type", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("%2B18165550001")) {
        return jsonResponse(carrierBody("mobile"));
      }
      if (u.includes("%2B18165550002")) {
        // carrier.type useless → portability decides
        return jsonResponse(carrierBody(null, "landline"));
      }
      return jsonResponse(carrierBody("something else"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const lookup = new TelnyxLineTypeLookup("key-123");
    const result = await lookup.classify([
      "+18165550001",
      "+18165550002",
      "+18165550003",
    ]);

    expect(result.get("+18165550001")).toBe("mobile");
    expect(result.get("+18165550002")).toBe("landline");
    expect(result.get("+18165550003")).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "https://api.telnyx.com/v2/number_lookup/",
    );
    expect(fetchMock.mock.calls[0][0]).toContain("type=carrier");
  });

  it("retries once on 429 then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(carrierBody("mobile")));
    vi.stubGlobal("fetch", fetchMock);

    const lookup = new TelnyxLineTypeLookup("key-123");
    const pending = lookup.classify(["+18165550001"]);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.get("+18165550001")).toBe("mobile");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns unknown (never throws) when a number fails twice", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    const lookup = new TelnyxLineTypeLookup("key-123");
    const result = await lookup.classify(["+18165550001"]);

    expect(result.get("+18165550001")).toBe("unknown");
    // A transport failure is ambiguous: the provider may have accepted and
    // charged the request, so the client must not automatically repeat it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns typed outcomes so durable workflows distinguish rejection from ambiguity", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockRejectedValueOnce(new Error("socket reset"));
    vi.stubGlobal("fetch", fetchMock);

    const lookup = new TelnyxLineTypeLookup("key-123");
    const rejectedPending = lookup.classifyOne("+18165550001");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(rejectedPending).resolves.toEqual({
      status: "retryable",
      lineType: "unknown",
      reason: "provider_rejected",
      httpStatus: 503,
    });
    await expect(lookup.classifyOne("+18165550002")).resolves.toEqual({
      status: "ambiguous",
      lineType: "unknown",
      reason: "transport_unknown",
      httpStatus: null,
    });
  });

  it("treats a 4xx (invalid number) as unknown without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 422));
    vi.stubGlobal("fetch", fetchMock);

    const lookup = new TelnyxLineTypeLookup("key-123");
    const result = await lookup.classify(["+10000000000"]);

    expect(result.get("+10000000000")).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not durably misclassify authentication failures as an invalid phone", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    vi.stubGlobal("fetch", fetchMock);

    const lookup = new TelnyxLineTypeLookup("bad-key");
    await expect(lookup.classifyOne("+18165550001")).resolves.toEqual({
      status: "retryable",
      lineType: "unknown",
      reason: "provider_rejected",
      httpStatus: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([402, 408, 409])(
    "keeps HTTP %i nonterminal so a job retry can recover without deleting the phone",
    async (httpStatus) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, httpStatus));
      vi.stubGlobal("fetch", fetchMock);

      const lookup = new TelnyxLineTypeLookup("key-123");
      await expect(lookup.classifyOne("+18165550001")).resolves.toEqual({
        status: "retryable",
        lineType: "unknown",
        reason: "provider_rejected",
        httpStatus,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

describe("telnyxLookupFromEnv", () => {
  it("throws ConfigurationError when TELNYX_API_KEY is unset", () => {
    vi.stubEnv("TELNYX_API_KEY", "");
    expect(() => telnyxLookupFromEnv()).toThrow(ConfigurationError);
  });

  it("builds a client when the key is present", () => {
    vi.stubEnv("TELNYX_API_KEY", "key-123");
    expect(telnyxLookupFromEnv()).toBeInstanceOf(TelnyxLineTypeLookup);
  });
});
