import { createHash, createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const cryptoSpies = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>(
    "node:crypto",
  );
  cryptoSpies.timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: cryptoSpies.timingSafeEqual };
});

type Consumer = {
  id: string;
  org_id: string;
  secret_hash: string;
  consumer_type: string;
  enabled: boolean;
  revoked_at: string | null;
};

let consumer: Consumer | null;
let lookupError: { message: string } | null;

function consumerBuilder() {
  const filters: Array<[string, unknown]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((key: string, value: unknown) => {
      filters.push([key, value]);
      return builder;
    }),
    is: vi.fn((key: string, value: unknown) => {
      filters.push([key, value]);
      return builder;
    }),
    update: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => {
      const candidate = consumer;
      return {
        data:
          candidate &&
          filters.every(([key, value]) =>
            key in candidate
              ? candidate[key as keyof Consumer] === value
              : true,
          )
            ? candidate
            : null,
        error: lookupError,
      };
    }),
  };
  return builder;
}

const serviceClient = { from: vi.fn(() => consumerBuilder()) };

vi.mock("./service-client", () => ({
  createSwitchboardServiceClient: () => serviceClient,
}));

import {
  authenticateSwitchboardPreference,
  isValidSwitchboardToken,
} from "./auth";

const TOKEN = "switchboard-test-token-000000000001";
const BODY = JSON.stringify({ event_id: "event-1" });
const ORG_ID = "00000000-0000-0000-0000-000000000bbb";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function signature(body = BODY, token = TOKEN): string {
  return `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
}

function request(
  headers: Record<string, string> = {},
  body = BODY,
): Request {
  return new Request(
    "https://sandra.test/api/internal/switchboard/contact-preferences",
    { method: "POST", headers, body },
  );
}

function validHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-sandra-signature": signature(),
  };
}

describe("authenticateSwitchboardPreference", () => {
  beforeEach(() => {
    consumer = {
      id: "consumer-1",
      org_id: ORG_ID,
      secret_hash: sha256(TOKEN),
      consumer_type: "switchboard_contact_preference",
      enabled: true,
      revoked_at: null,
    };
    lookupError = null;
    serviceClient.from.mockClear();
    cryptoSpies.timingSafeEqual.mockClear();
  });

  it("returns 401 for missing bearer authentication", async () => {
    const result = await authenticateSwitchboardPreference(
      request({ "x-sandra-signature": signature() }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("shares a strict header-safe 32-256 byte token contract", () => {
    expect(isValidSwitchboardToken(TOKEN)).toBe(true);
    expect(isValidSwitchboardToken("x".repeat(31))).toBe(false);
    expect(isValidSwitchboardToken("x".repeat(257))).toBe(false);
    expect(isValidSwitchboardToken(`${"x".repeat(31)},`)).toBe(false);
    expect(isValidSwitchboardToken(`${"x".repeat(31)} `)).toBe(false);
    expect(isValidSwitchboardToken(`${"x".repeat(31)}é`)).toBe(false);
  });

  it("rejects duplicate/coalesced auth and signature headers before body reads", async () => {
    let pulls = 0;
    const duplicateHeaders = new Headers(validHeaders());
    duplicateHeaders.append("authorization", `Bearer ${TOKEN}`);
    duplicateHeaders.append("x-sandra-signature", signature());
    const incoming = {
      headers: duplicateHeaders,
      body: {
        getReader() {
          pulls += 1;
          throw new Error("body must not be read");
        },
      },
    } as unknown as Request;
    const result = await authenticateSwitchboardPreference(incoming);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(pulls).toBe(0);
  });

  it("does not read an unauthenticated oversized stream", async () => {
    let pulls = 0;
    const incoming = {
      headers: new Headers(),
      body: {
        getReader() {
          pulls += 1;
          throw new Error("unauthenticated body was read");
        },
      },
    } as unknown as Request;
    const result = await authenticateSwitchboardPreference(incoming);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(pulls).toBe(0);
  });

  it("caps authenticated raw bodies at 64 KiB with a generic 413", async () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    const incoming = request(
      {
        authorization: `Bearer ${TOKEN}`,
        "x-sandra-signature": signature(oversized),
      },
      oversized,
    );
    const result = await authenticateSwitchboardPreference(incoming);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      await expect(result.response.json()).resolves.toEqual({
        error: "bad_request",
      });
    }
  });

  it("fails generically when the authenticated body stream breaks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("PII +18165550123");
      },
    });
    const incoming = new Request(
      "https://sandra.test/api/internal/switchboard/contact-preferences",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-sandra-signature": `sha256=${"a".repeat(64)}`,
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    await expect(
      authenticateSwitchboardPreference(incoming),
    ).rejects.toThrow("switchboard_request_body_unreadable");
  });

  it.each([
    ["wrong consumer type", { consumer_type: "provider" }],
    ["disabled consumer", { enabled: false }],
    ["revoked consumer", { revoked_at: "2026-08-30T00:00:00.000Z" }],
  ])("returns 401 for %s", async (_label, patch) => {
    consumer = { ...consumer!, ...patch };
    const result = await authenticateSwitchboardPreference(
      request(validHeaders()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns 401 for a lookup failure without exposing details", async () => {
    lookupError = { message: "database unavailable" };
    const result = await authenticateSwitchboardPreference(
      request(validHeaders()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({
        error: "unauthorized",
      });
    }
  });

  it("returns 401 when the signature is missing or does not bind the raw body", async () => {
    const missing = await authenticateSwitchboardPreference(
      request({ authorization: `Bearer ${TOKEN}` }),
    );
    expect(missing.ok).toBe(false);

    const invalid = await authenticateSwitchboardPreference(
      request({
        authorization: `Bearer ${TOKEN}`,
        "x-sandra-signature": signature("different-body"),
      }),
    );
    expect(invalid.ok).toBe(false);
  });

  it("returns the consumer-bound organization for a valid signed body", async () => {
    const result = await authenticateSwitchboardPreference(
      request(validHeaders()),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consumerId).toBe("consumer-1");
    expect(result.orgId).toBe(ORG_ID);
    expect(result.rawBody).toBe(BODY);
    expect(result.serviceClient).toBe(serviceClient);
  });

  it("uses constant-time comparison for equal-length secrets and signatures", async () => {
    await authenticateSwitchboardPreference(request(validHeaders()));
    expect(cryptoSpies.timingSafeEqual).toHaveBeenCalled();
    for (const [left, right] of cryptoSpies.timingSafeEqual.mock.calls) {
      expect(left).toHaveLength(right.length);
    }
  });

  it("does not log credentials or signed request bodies", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await authenticateSwitchboardPreference(request(validHeaders()));
    const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(signature());
    expect(output).not.toContain(BODY);
    log.mockRestore();
    error.mockRestore();
  });
});
