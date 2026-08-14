import { timingSafeEqual } from "node:crypto";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import type {
  MessagingProvider,
  ProviderCampaignSummary,
  ProviderSenderNumber,
  SmsInboundEvent,
  SmsOutboundInput,
  SmsSendResult,
  SmsStatusEvent,
} from "../types";

const API_BASE = "https://www.sendillo.com/api/v1";
const SEND_ENDPOINT = `${API_BASE}/messages`;
const PURCHASED_NUMBERS_ENDPOINT = `${API_BASE}/numbers/purchased`;
const CAMPAIGNS_ENDPOINT = `${API_BASE}/campaigns`;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

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

  /**
   * `opts.signal` (Codex round 7, finding 1, item 5): an external deadline
   * — the reminder sweep's per-delivery timeout — combined with this
   * method's own `DEFAULT_SEND_TIMEOUT_MS` controller so whichever fires
   * first tears down the request. This is best-effort local cancellation
   * ONLY: aborting a fetch mid-flight doesn't tell us whether Sendillo's
   * server had already received the request before the abort landed (the
   * standard fetch API surface here has no hook for "was the body fully
   * flushed"), so an abort still throws the same `ProviderError` as any
   * other network failure — callers must NOT treat it as a confirmed
   * non-delivery, only as "we stopped waiting."
   */
  async sendSms(
    input: SmsOutboundInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SmsSendResult> {
    const payload = {
      from: input.from ?? this.fromNumber,
      to: input.to,
      body: input.body,
    };

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_SEND_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onExternalAbort);
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
      opts.signal?.removeEventListener("abort", onExternalAbort);
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
   * Read-only catalog sync: purchased sender numbers via
   * GET /api/v1/numbers/purchased. Parsing is defensive (same posture as
   * sendSms) because the OpenAPI document confirms the endpoint but not
   * every field name across plans.
   */
  async listPurchasedNumbers(): Promise<ProviderSenderNumber[]> {
    const entries = await this.fetchCatalogList(
      PURCHASED_NUMBERS_ENDPOINT,
      "purchased numbers",
    );
    const numbers: ProviderSenderNumber[] = [];
    for (const entry of entries) {
      const phone =
        readString(entry, "phoneNumber") ??
        readString(entry, "phone_number") ??
        readString(entry, "number") ??
        readString(entry, "phone");
      if (!phone) {
        reportMalformedCatalogEntry(entry, "purchased numbers", "missing phone");
        continue;
      }
      numbers.push({
        phoneE164: phone,
        providerNumberId:
          readString(entry, "id") ?? readString(entry, "numberId"),
        status: readString(entry, "status"),
        messagingStatus:
          readString(entry, "messagingStatus") ??
          readString(entry, "messaging_status") ??
          readString(entry, "smsStatus"),
        raw: entry,
      });
    }
    return numbers;
  }

  /**
   * Read-only catalog sync: provider campaigns via GET /api/v1/campaigns.
   */
  async listProviderCampaigns(): Promise<ProviderCampaignSummary[]> {
    const entries = await this.fetchCatalogList(
      CAMPAIGNS_ENDPOINT,
      "campaigns",
    );
    const campaigns: ProviderCampaignSummary[] = [];
    for (const entry of entries) {
      const externalId =
        readString(entry, "id") ?? readString(entry, "campaignId");
      if (!externalId) {
        reportMalformedCatalogEntry(entry, "campaigns", "missing id");
        continue;
      }
      campaigns.push({
        externalId,
        name: readString(entry, "name") ?? readString(entry, "title"),
        brand:
          readString(entry, "brand") ?? readString(entry, "brandName"),
        useCase:
          readString(entry, "useCase") ?? readString(entry, "use_case"),
        status: readString(entry, "status"),
        raw: entry,
      });
    }
    return campaigns;
  }

  private async fetchCatalogList(
    endpoint: string,
    label: string,
  ): Promise<JsonObject[]> {
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_SEND_TIMEOUT_MS);
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
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
        `Sendillo ${label} ${response.status}: ${errorMessage}`,
        "sendillo",
        { status: response.status, response: parsed },
      );
    }

    // Sendillo OpenAPI checked 2026-07-02: GET /api/v1/campaigns and
    // GET /api/v1/numbers/purchased expose no pagination parameters, and the
    // 200 schema is only "object". Treat the returned list as complete until
    // the contract adds explicit page/cursor fields.
    const list =
      arrayValue(parsed) ??
      arrayValue(objectValue(parsed, "data")) ??
      arrayValue((parsed as JsonObject | null)?.["items"]) ??
      arrayValue((parsed as JsonObject | null)?.["results"]);
    if (!list) {
      throw new ProviderError(
        `Sendillo ${label} response was not a list`,
        "sendillo",
        { response: parsed },
      );
    }
    return list.filter(
      (entry): entry is JsonObject =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    );
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
    const querySecret = readQuerySecret(fullUrl, "secret");
    if (querySecret) candidates.add(querySecret);

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
    const { parsed, event, payload } = parseWebhookEnvelope(
      rawBody,
      "Sendillo inbound payload was not JSON",
    );

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

  parseStatusWebhook(rawBody: string): SmsStatusEvent[] {
    const { parsed, event, payload } = parseWebhookEnvelope(
      rawBody,
      "Sendillo status payload was not JSON",
    );

    switch (event) {
      case "message.sent":
        return [
          buildStatusEvent("sent", payload, parsed, [
            "sentAt",
            "createdAt",
          ]),
        ];
      case "message.delivered":
        return [
          buildStatusEvent("delivered", payload, parsed, [
            "deliveredAt",
            "sentAt",
            "createdAt",
          ]),
        ];
      case "message.failed":
        return [
          buildStatusEvent(
            "failed",
            payload,
            parsed,
            ["failedAt", "createdAt"],
            readString(payload, "error") ?? readString(payload, "reason") ?? undefined,
          ),
        ];
      default:
        return [];
    }
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

function reportMalformedCatalogEntry(
  entry: JsonObject,
  label: string,
  reason: string,
): void {
  reportError(
    new ProviderError(
      `Sendillo ${label} catalog entry skipped: ${reason}`,
      "sendillo",
    ),
    {
      tags: { surface: "sendillo_catalog_parse" },
      extra: {
        label,
        reason,
        providerEntryId:
          readString(entry, "id") ??
          readString(entry, "numberId") ??
          readString(entry, "campaignId") ??
          null,
      },
    },
  );
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseWebhookEnvelope(rawBody: string, errorMessage: string) {
  const parsed = safeParseJson(rawBody);
  if (!parsed || typeof parsed !== "object") {
    throw new ProviderError(errorMessage, "sendillo");
  }

  const root = parsed as JsonObject;
  return {
    parsed,
    event:
      readString(root, "event") ??
      readString(root, "eventType") ??
      readString(root, "type"),
    payload: objectValue(root, "data") ?? root,
  };
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
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

function buildStatusEvent(
  kind: SmsStatusEvent["kind"],
  payload: JsonObject,
  rawPayload: unknown,
  timestampFields: string[],
  errorMessage?: string,
): SmsStatusEvent {
  const externalId =
    readString(payload, "messageId") ??
    readString(payload, "id");
  if (!externalId) {
    throw new ProviderError(
      "Sendillo status payload missing messageId",
      "sendillo",
      { payload: rawPayload },
    );
  }

  const timestamp =
    parseRequiredTimestamp(rawPayload, payload, timestampFields);

  return {
    kind,
    externalId,
    timestamp,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function parseRequiredTimestamp(
  rawPayload: unknown,
  payload: JsonObject,
  timestampFields: string[],
): Date {
  const rawTimestamp =
    timestampFields
      .map((field) => readString(payload, field))
      .find((value): value is string => typeof value === "string") ?? null;
  if (!rawTimestamp) {
    throw new ProviderError(
      `Sendillo status payload missing ${timestampFields.join("/")}`,
      "sendillo",
      { payload: rawPayload },
    );
  }

  const parsed = new Date(rawTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    throw new ProviderError(
      `Sendillo status payload had invalid timestamp: ${rawTimestamp}`,
      "sendillo",
      { payload: rawPayload },
    );
  }
  return parsed;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readQuerySecret(fullUrl: string | undefined, key: string): string | null {
  if (!fullUrl) return null;
  try {
    return new URL(fullUrl).searchParams.get(key)?.trim() || null;
  } catch {
    return null;
  }
}
