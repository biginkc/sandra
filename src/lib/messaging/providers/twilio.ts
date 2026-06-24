import { ConfigurationError, ProviderError } from "@/lib/errors/classes";
import type {
  MessagingProvider,
  SmsInboundEvent,
  SmsOutboundInput,
  SmsSendResult,
} from "../types";
import {
  parseTwilioInbound,
  verifyTwilioSignature,
} from "./twilio-receiver";

/**
 * Twilio SMS adapter for outbound + inbound. Uses Twilio's REST API
 * v2010-04-01 (https://www.twilio.com/docs/messaging/api). Requires:
 *
 *   TWILIO_ACCOUNT_SID            — account SID, "AC..."
 *   TWILIO_AUTH_TOKEN             — auth token (the actual secret)
 *   TWILIO_MESSAGING_SERVICE_SID  — preferred for 10DLC: "MG..."
 *   TWILIO_FROM_NUMBER            — fallback E.164 number when no service SID
 *
 * For 10DLC the recommended path is a Messaging Service which holds the
 * brand+campaign+pool of numbers. We prefer it when set; fall back to a
 * single From number for testing or non-10DLC accounts.
 *
 * Signature verification + inbound parsing are reused from the existing
 * `twilio-receiver` helpers — same canonical-string scheme regardless of
 * which webhook route the request hits.
 */

const API_BASE = "https://api.twilio.com";
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** Preferred for 10DLC; takes precedence over fromNumber when set. */
  messagingServiceSid?: string;
  /** Fallback E.164 number used when messagingServiceSid is unset. */
  fromNumber?: string;
};

export class TwilioMessagingProvider implements MessagingProvider {
  readonly providerId = "twilio";

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly messagingServiceSid?: string;
  private readonly fromNumber?: string;

  constructor(config: TwilioConfig) {
    if (!config.accountSid || !config.authToken) {
      throw new ConfigurationError(
        "Twilio adapter requires accountSid and authToken.",
      );
    }
    if (!config.messagingServiceSid && !config.fromNumber) {
      throw new ConfigurationError(
        "Twilio adapter requires either messagingServiceSid or fromNumber.",
      );
    }
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.messagingServiceSid = config.messagingServiceSid;
    this.fromNumber = config.fromNumber;
  }

  getDefaultFromNumber(): string | null {
    return this.fromNumber ?? null;
  }

  async sendSms(input: SmsOutboundInput): Promise<SmsSendResult> {
    const params = new URLSearchParams();
    params.set("To", input.to);
    params.set("Body", input.body);
    if (input.from) {
      // Caller-overridden From wins over both env settings.
      params.set("From", input.from);
    } else if (this.messagingServiceSid) {
      params.set("MessagingServiceSid", this.messagingServiceSid);
    } else if (this.fromNumber) {
      params.set("From", this.fromNumber);
    }

    const url = `${API_BASE}/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString(
      "base64",
    );

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_SEND_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal: controller.signal,
      });
    } catch (e) {
      throw new ProviderError(
        e instanceof Error ? e.message : String(e),
        "twilio",
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    const parsed = safeParseJson(text);
    if (!response.ok) {
      throw new ProviderError(
        `Twilio ${response.status}: ${text || response.statusText}`,
        "twilio",
        { status: response.status, response: parsed },
      );
    }

    const sid =
      parsed && typeof parsed === "object" && "sid" in parsed
        ? String((parsed as { sid: unknown }).sid)
        : null;
    if (!sid) {
      throw new ProviderError(
        "Twilio send succeeded but response had no sid",
        "twilio",
        { response: parsed },
      );
    }

    const status =
      parsed && typeof parsed === "object" && "status" in parsed
        ? String((parsed as { status: unknown }).status)
        : "queued";

    return { externalId: sid, providerStatus: status, raw: parsed };
  }

  /**
   * Twilio's signature scheme folds the full request URL into the
   * canonical string. Without the URL we can't verify — return false
   * (caller should 401) rather than risk accepting a forged request.
   */
  verifyWebhookSignature(
    rawBody: string,
    headers: Headers,
    fullUrl?: string,
  ): boolean {
    if (!fullUrl) return false;
    const params = new URLSearchParams(rawBody);
    const form: Record<string, string> = {};
    for (const [k, v] of params.entries()) form[k] = v;
    return verifyTwilioSignature({
      authToken: this.authToken,
      fullUrl,
      form,
      signatureHeader: headers.get("x-twilio-signature"),
    });
  }

  /**
   * Twilio sends one event per webhook delivery (no batching), so we
   * always return a one-element array. Throws when required fields are
   * missing — caller should 400 (Twilio won't retry on 400).
   */
  parseInboundWebhook(rawBody: string): SmsInboundEvent[] {
    const parsed = parseTwilioInbound(rawBody);
    if (!parsed) {
      throw new ProviderError(
        "Twilio inbound payload missing MessageSid / From / To / Body",
        "twilio",
      );
    }

    // MMS: Twilio sends NumMedia + MediaUrl0..MediaUrl{N-1}
    const numMedia = parseInt(parsed.form["NumMedia"] ?? "0", 10);
    const mediaUrls: string[] = [];
    if (numMedia > 0) {
      for (let i = 0; i < numMedia; i++) {
        const url = parsed.form[`MediaUrl${i}`];
        if (url) mediaUrls.push(url);
      }
    }

    return [
      {
        externalId: parsed.messageSid,
        from: parsed.from,
        to: parsed.to,
        body: parsed.body,
        receivedAt: new Date(),
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        raw: parsed.form,
      },
    ];
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function twilioFromEnv(): TwilioMessagingProvider {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken) {
    throw new ConfigurationError(
      "Twilio credentials missing. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env.local.",
    );
  }
  if (!messagingServiceSid && !fromNumber) {
    throw new ConfigurationError(
      "Twilio sender missing. Set TWILIO_MESSAGING_SERVICE_SID (preferred for 10DLC) or TWILIO_FROM_NUMBER in .env.local.",
    );
  }
  return new TwilioMessagingProvider({
    accountSid,
    authToken,
    messagingServiceSid,
    fromNumber,
  });
}
