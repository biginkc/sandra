import { timingSafeEqual } from "node:crypto";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";
import type {
  MessagingProvider,
  SmsInboundEvent,
  SmsOutboundInput,
  SmsSendResult,
} from "../types";

const API_BASE = "https://www.sendillo.com/api/v1";
const SEND_ENDPOINT = `${API_BASE}/messages`;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

type SendilloConfig = {
  apiKey: string;
  fromNumber: string;
  webhookSecret?: string | null;
};

type JsonObject = Record<string, unknown>;

export class SendilloMessagingProvider implements MessagingProvider {
  readonly providerId = "sendillo";

  constructor(
    private readonly apiKey: string,
    private readonly fromNumber: string,
    private readonly webhookSecret?: string | null,
  ) {}

  getDefaultFromNumber(): string | null {
    return this.fromNumber;
  }

  async sendSms(input: SmsOutboundInput): Promise<SmsSendResult> {
    const payload = {
      from: input.from ?? this.fromNumber,
      to: input.to,
      body: input.body,
    };

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_SEND_TIMEOUT_MS);
    try {
      response = await fetch(SEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      throw new ProviderError(
        e instanceof Error ? e.message : String(e),
        "sendillo",
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    const parsed = safeParseJson(text);
    if (!response.ok) {
      const errorMessage = extractErrorMessage(parsed) || text || response.statusText;
      throw new ProviderError(
        `Sendillo ${response.status}: ${errorMessage}`,
        "sendillo",
        { status: response.status, response: parsed },
      );
    }

    const externalId =
      readString(parsed, "data", "messageId") ??
      readString(parsed, "messageId") ??
      readString(parsed, "data", "id") ??
      readString(parsed, "id");
    if (!externalId) {
      throw new ProviderError(
        "Sendillo send succeeded but response had no messageId",
        "sendillo",
        { response: parsed },
      );
    }

    return {
      externalId,
      providerStatus:
        readString(parsed, "data", "status") ??
        readString(parsed, "status") ??
        "accepted",
      raw: parsed,
    };
  }

  /**
   * Sendillo's public guides enumerate webhook events but do not publish
   * a signature or shared-secret verification contract. Keep inbound
   * cutover gated until their authenticated docs or a captured delivery
   * confirms the real verification scheme.
   */
  verifyWebhookSignature(
    _rawBody: string,
    headers: Headers,
    fullUrl?: string,
  ): boolean {
    if (!this.webhookSecret) return false;

    const candidates = new Set<string>();
    const auth = headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      candidates.add(auth.slice("Bearer ".length).trim());
    }
    const explicitHeader = headers.get("x-sendillo-webhook-secret");
    if (explicitHeader) candidates.add(explicitHeader.trim());

    if (fullUrl) {
      try {
        const url = new URL(fullUrl);
        const querySecret = url.searchParams.get("secret");
        if (querySecret) candidates.add(querySecret.trim());
      } catch {
        return false;
      }
    }

    for (const candidate of candidates) {
      if (constantTimeEqual(candidate, this.webhookSecret)) return true;
    }
    return false;
  }

  /**
   * Best-effort parser for the documented event names. The public docs
   * confirm that inbound and delivery webhooks are JSON POST bodies and
   * that outbound events carry messageId/from/to identifiers. This parser
   * stays intentionally broad until Sendillo publishes or we capture the
   * exact payload schema used for inbound.received.
   */
  parseInboundWebhook(rawBody: string): SmsInboundEvent[] {
    const parsed = safeParseJson(rawBody);
    if (!parsed || typeof parsed !== "object") {
      throw new ProviderError("Sendillo inbound payload was not JSON", "sendillo");
    }

    const root = parsed as JsonObject;
    const event =
      readString(root, "event") ??
      readString(root, "eventType") ??
      readString(root, "type");
    const payload = objectValue(root, "data") ?? root;

    if (event && event !== "inbound.received") {
      return [];
    }

    const externalId =
      readString(payload, "messageId") ??
      readString(payload, "id");
    const from = readString(payload, "from");
    const to = readString(payload, "to");
    const body = readString(payload, "body") ?? readString(payload, "text");

    if (!externalId || !from || !to || body == null) {
      throw new ProviderError(
        "Sendillo inbound payload missing messageId/from/to/body",
        "sendillo",
        { payload: parsed },
      );
    }

    const mediaUrls =
      stringArrayValue(payload, "mediaUrls") ??
      stringArrayValue(payload, "media_urls");

    return [
      {
        externalId,
        from,
        to,
        body,
        receivedAt: parseDate(
          readString(payload, "receivedAt") ??
            readString(payload, "sentAt") ??
            readString(payload, "createdAt"),
        ),
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
        raw: parsed,
      },
    ];
  }
}

export function sendilloFromEnv(): SendilloMessagingProvider {
  const apiKey = process.env.SENDILLO_API_KEY;
  const fromNumber = process.env.SENDILLO_FROM_NUMBER;
  const webhookSecret = process.env.SENDILLO_WEBHOOK_SECRET ?? null;
  if (!apiKey || !fromNumber) {
    throw new ConfigurationError(
      "Sendillo credentials missing. Set SENDILLO_API_KEY and SENDILLO_FROM_NUMBER in .env.local.",
    );
  }
  return new SendilloMessagingProvider(apiKey, fromNumber, webhookSecret);
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function objectValue(
  value: unknown,
  key: string,
): JsonObject | null {
  if (!value || typeof value !== "object") return null;
  const child = (value as JsonObject)[key];
  return child && typeof child === "object" ? (child as JsonObject) : null;
}

function readString(value: unknown, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as JsonObject)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

function stringArrayValue(value: unknown, key: string): string[] | null {
  if (!value || typeof value !== "object") return null;
  const child = (value as JsonObject)[key];
  if (!Array.isArray(child)) return null;
  const strings = child.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : [];
}

function extractErrorMessage(parsed: unknown): string | null {
  return (
    readString(parsed, "error", "message") ??
    readString(parsed, "message") ??
    readString(parsed, "data", "error")
  );
}

function parseDate(raw: string | null): Date {
  if (!raw) return new Date();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
