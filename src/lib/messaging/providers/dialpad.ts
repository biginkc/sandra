import { createHmac, timingSafeEqual } from "node:crypto";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";
import type {
  DialpadFromOption,
  MessagingProvider,
  SmsInboundEvent,
  SmsOutboundInput,
  SmsSendResult,
} from "../types";

/**
 * Dialpad SMS adapter. Uses the Dialpad API v2 REST endpoints — docs at
 * https://developers.dialpad.com. Requires:
 *   DIALPAD_API_KEY        — bearer token, created in the Dialpad console
 *   DIALPAD_FROM_NUMBER    — E.164 number owned by the account ("+1...")
 *   DIALPAD_WEBHOOK_SECRET — shared secret registered with the Dialpad
 *                             webhook. Dialpad signs event deliveries as
 *                             HS256 JWTs using this secret; the request
 *                             body IS the JWT string.
 */

const API_BASE = "https://dialpad.com/api/v2";
const SEND_ENDPOINT = `${API_BASE}/sms`;
const NUMBERS_ENDPOINT = `${API_BASE}/numbers`;

export class DialpadMessagingProvider implements MessagingProvider {
  readonly providerId = "dialpad";

  constructor(
    private readonly apiKey: string,
    private readonly fromNumber: string,
    private readonly webhookSecret: string,
  ) {}

  async sendSms(input: SmsOutboundInput): Promise<SmsSendResult> {
    const body = {
      to_numbers: [input.to],
      from_number: input.from ?? this.fromNumber,
      text: input.body,
    };

    let response: Response;
    try {
      response = await fetch(SEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ProviderError(
        e instanceof Error ? e.message : String(e),
        "dialpad",
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(
        `Dialpad ${response.status}: ${text || response.statusText}`,
        "dialpad",
        { status: response.status },
      );
    }

    const parsed = safeParseJson(text);
    const externalId =
      (parsed && typeof parsed === "object" && "id" in parsed
        ? String((parsed as { id: unknown }).id)
        : null) ??
      (parsed && typeof parsed === "object" && "message_id" in parsed
        ? String((parsed as { message_id: unknown }).message_id)
        : null);
    if (!externalId) {
      throw new ProviderError(
        "Dialpad send succeeded but response had no message id",
        "dialpad",
        { response: parsed },
      );
    }

    return {
      externalId,
      providerStatus:
        (parsed && typeof parsed === "object" && "status" in parsed
          ? String((parsed as { status: unknown }).status)
          : null) ?? "sent",
      raw: parsed,
    };
  }

  /**
   * Dialpad signs webhook deliveries as HS256 JWTs — the entire
   * request body IS the JWT string (header.payload.signature, each
   * base64url-encoded). We verify the signature against our shared
   * secret; no separate header.
   *
   * Spec reference (Dialpad docs): "Events are encoded and signed in
   * the JWT format using the shared secret with the HS256 algorithm.
   * The JWT payload should be decoded and the signature verified to
   * ensure that the event came from Dialpad."
   */
  verifyWebhookSignature(
    rawBody: string,
    _headers: Headers,
    _fullUrl?: string,
  ): boolean {
    return this.decodeSignedJwt(rawBody.trim()) !== null;
  }

  /**
   * Verify a JWT string against the configured webhook secret and
   * return the parsed payload object on success, or null on any
   * failure (malformed, wrong signature, bad JSON payload).
   * Intentionally silent on failure — the caller maps null to a 401.
   */
  private decodeSignedJwt(jwt: string): Record<string, unknown> | null {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    let received: Buffer;
    try {
      received = Buffer.from(sigB64, "base64url");
    } catch {
      return null;
    }
    const expected = createHmac("sha256", this.webhookSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    if (received.length !== expected.length) return null;
    if (!timingSafeEqual(received, expected)) return null;
    try {
      const payloadJson = Buffer.from(payloadB64, "base64url").toString(
        "utf8",
      );
      const obj = JSON.parse(payloadJson);
      return obj && typeof obj === "object" ? obj : null;
    } catch {
      return null;
    }
  }

  /**
   * List the account's provisioned phone numbers with human-readable
   * owner labels resolved from the users / offices endpoints. Result
   * feeds the composer's "send from" dropdown.
   *
   * Cost: 1 list call + up to N detail calls (one per unique owner),
   * parallelized. For BMH's 5 numbers this is 3–6 HTTP calls — fine
   * on-demand at composer open.
   */
  async listFromNumbers(): Promise<DialpadFromOption[]> {
    const url = `${NUMBERS_ENDPOINT}?limit=100`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (e) {
      throw new ProviderError(
        e instanceof Error ? e.message : String(e),
        "dialpad",
      );
    }
    if (!res.ok) {
      throw new ProviderError(
        `Dialpad ${res.status}: ${await res.text().catch(() => res.statusText)}`,
        "dialpad",
      );
    }
    const data = (await res.json()) as {
      items?: Array<{
        number?: string;
        status?: string;
        target_id?: string | number;
        target_type?: string;
      }>;
    };
    const items = data.items ?? [];

    // Resolve owner names in parallel — but only fetch each (type,id)
    // once. The "available" numbers have no target.
    const needed = new Map<string, { type: string; id: string }>();
    for (const item of items) {
      if (item.target_id && item.target_type) {
        const key = `${item.target_type}:${item.target_id}`;
        needed.set(key, {
          type: item.target_type,
          id: String(item.target_id),
        });
      }
    }
    const nameEntries = await Promise.all(
      [...needed.entries()].map(async ([key, { type, id }]) => {
        const name = await this.resolveOwnerName(type, id);
        return [key, name] as const;
      }),
    );
    const names = new Map(nameEntries);

    return items
      .filter((i) => typeof i.number === "string")
      .map((i): DialpadFromOption => {
        const key =
          i.target_type && i.target_id
            ? `${i.target_type}:${i.target_id}`
            : null;
        const ownerName =
          (key && names.get(key)) ??
          (i.status === "available" ? "(unassigned)" : "(unknown)");
        return {
          number: i.number!,
          ownerName,
          ownerType: i.target_type ?? i.status ?? "unknown",
          status: i.status ?? "unknown",
        };
      });
  }

  private async resolveOwnerName(
    type: string,
    id: string,
  ): Promise<string | null> {
    const endpoint =
      type === "user"
        ? `${API_BASE}/users/${id}`
        : type === "office"
          ? `${API_BASE}/offices/${id}`
          : null;
    if (!endpoint) return null;
    try {
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        display_name?: string;
        name?: string;
        first_name?: string;
        last_name?: string;
      };
      if (body.display_name) return body.display_name;
      if (body.name) return body.name;
      const fullName = [body.first_name, body.last_name]
        .filter(Boolean)
        .join(" ");
      return fullName || null;
    } catch {
      return null;
    }
  }

  /**
   * Decode the JWT (must already be signature-verified by the caller),
   * then flatten the payload into zero-or-more `SmsInboundEvent`s.
   * Dialpad sends a single event per delivery in practice, but the
   * parser tolerates the wrapped `{events: [...]}` and bare-array
   * shapes too in case that changes.
   */
  parseInboundWebhook(rawBody: string): SmsInboundEvent[] {
    const parsed = this.decodeSignedJwt(rawBody.trim());
    if (!parsed) {
      throw new ProviderError(
        "Dialpad webhook body is not a valid signed JWT",
        "dialpad",
      );
    }
    const events = Array.isArray(parsed)
      ? parsed
      : "events" in parsed && Array.isArray((parsed as { events: unknown }).events)
        ? ((parsed as { events: unknown[] }).events as unknown[])
        : [parsed];

    const out: SmsInboundEvent[] = [];
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;

      const externalId =
        toStringOrNull(r.id) ?? toStringOrNull(r.message_id) ?? null;
      const from =
        toStringOrNull(r.from_number) ?? toStringOrNull(r.from) ?? null;
      const to = toStringOrNull(r.to_number) ?? toStringOrNull(r.to) ?? null;
      const body = toStringOrNull(r.text) ?? toStringOrNull(r.body) ?? "";
      if (!externalId || !from || !to) {
        throw new ProviderError(
          "Dialpad inbound event missing id / from / to",
          "dialpad",
          { event: r },
        );
      }
      const receivedAt =
        toStringOrNull(r.timestamp) ?? toStringOrNull(r.created_at);
      const mediaUrls = Array.isArray(r.media_urls)
        ? r.media_urls.filter((m): m is string => typeof m === "string")
        : undefined;

      out.push({
        externalId,
        from,
        to,
        body,
        receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
        mediaUrls,
        raw: r,
      });
    }
    return out;
  }
}

function toStringOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length > 0 ? s : null;
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function dialpadFromEnv(): DialpadMessagingProvider {
  const apiKey = process.env.DIALPAD_API_KEY;
  const fromNumber = process.env.DIALPAD_FROM_NUMBER;
  const webhookSecret = process.env.DIALPAD_WEBHOOK_SECRET;
  if (!apiKey || !fromNumber || !webhookSecret) {
    throw new ConfigurationError(
      "Dialpad credentials missing. Set DIALPAD_API_KEY, DIALPAD_FROM_NUMBER, and DIALPAD_WEBHOOK_SECRET in .env.local.",
    );
  }
  return new DialpadMessagingProvider(apiKey, fromNumber, webhookSecret);
}
