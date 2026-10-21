import { ConfigurationError } from "@/lib/errors/classes";

import type {
  VoicemailDropProvider,
  VoicemailDropSendInput,
  VoicemailDropSendResult,
  WebhookHeaders,
} from "../types";
import {
  parseDropCowboyCallback,
  parseDropCowboyStatusWebhook,
  verifyDropCowboySignature,
} from "../webhook";

export const DROPCOWBOY_BASE_URL = "https://api-v2.dropcowboy.com";
export const DROPCOWBOY_DEFAULT_TIMEOUT_MS = 15_000;

export type DropCowboyConfig = {
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function buildDropCowboyRvmBody(input: VoicemailDropSendInput): Record<string, unknown> {
  const callerId = input.callerId?.trim() || null;
  const phoneLineId = input.phoneLineId?.trim() || null;
  if (!callerId && !phoneLineId) {
    throw new Error("voicemail drop needs a callerId (BYOC) or a phoneLineId");
  }
  if (callerId && !/^\+[1-9]\d{1,14}$/.test(callerId)) {
    throw new Error("voicemail drop callerId must be E.164");
  }
  // BYOC: caller_id only. Drop Cowboy ignores caller_id when phone_line_id is
  // also sent (SendRvm / SendCallerId), so never send both.
  const body: Record<string, unknown> = {
    to: input.to,
    ...(callerId ? { caller_id: callerId } : { phone_line_id: phoneLineId }),
    foreign_id: input.foreignId,
    callback_url: input.callbackUrl,
    mobile_only: input.mobileOnly,
    max_attempts: input.maxAttempts,
  };
  if (input.postalCode) body.postal_code = input.postalCode;
  const brandId = input.brandId?.trim();
  if (brandId) body.brand_id = brandId;
  if (input.audio.kind === "tts") {
    body.tts_body = input.audio.ttsBody;
    body.voice_id = input.audio.voiceId;
  } else {
    body.media_id = input.audio.mediaId;
  }
  return body;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function detailOf(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "detail" in raw) {
    const d = (raw as { detail?: unknown }).detail;
    return typeof d === "string" ? d : null;
  }
  return null;
}

export class DropCowboyVoicemailDropProvider implements VoicemailDropProvider {
  readonly id = "dropcowboy" as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: DropCowboyConfig) {
    this.baseUrl = (config.baseUrl ?? DROPCOWBOY_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DROPCOWBOY_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async sendDrop(input: VoicemailDropSendInput): Promise<VoicemailDropSendResult> {
    // Build before any network call: a bad input never reaches Drop Cowboy.
    let requestBody: string;
    try {
      requestBody = JSON.stringify(buildDropCowboyRvmBody(input));
    } catch (error) {
      return {
        outcome: "bad_request",
        httpStatus: 400,
        detail: error instanceof Error ? error.message : String(error),
        raw: null,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/rvm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-key": this.config.apiKey,
          "x-secret": this.config.apiSecret,
          "Idempotency-Key": input.idempotencyKey,
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut =
        controller.signal.aborted ||
        (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
      return {
        outcome: "unknown",
        httpStatus: null,
        cause: timedOut ? "timeout" : "network",
        error: error instanceof Error ? error.message : String(error),
        raw: null,
      };
    } finally {
      clearTimeout(timer);
    }

    let raw: unknown;
    try {
      raw = await readBody(res);
    } catch {
      raw = null;
    }

    switch (res.status) {
      case 202: {
        const messageId =
          raw && typeof raw === "object" && typeof (raw as { message_id?: unknown }).message_id === "string"
            ? ((raw as { message_id: string }).message_id)
            : null;
        return { outcome: "accepted", httpStatus: 202, messageId, raw };
      }
      case 429:
      case 500:
        return { outcome: "not_queued", httpStatus: res.status, raw };
      case 502:
        return { outcome: "unknown", httpStatus: 502, cause: "no_receipt", raw };
      case 400:
        return { outcome: "bad_request", httpStatus: 400, detail: detailOf(raw), raw };
      case 401:
        return { outcome: "unauthorized", httpStatus: 401, detail: detailOf(raw), raw };
      default:
        // Undocumented status: we cannot tell whether it queued. Never retry.
        return { outcome: "unknown", httpStatus: res.status, cause: "unexpected_status", raw };
    }
  }

  verifyWebhookSignature(rawBody: string, headers: WebhookHeaders, nowMs?: number) {
    return verifyDropCowboySignature(this.config.webhookSecret, rawBody, headers, nowMs);
  }

  parseStatusWebhook(rawBody: string) {
    return parseDropCowboyStatusWebhook(rawBody);
  }

  parseCallback(rawBody: string) {
    return parseDropCowboyCallback(rawBody);
  }
}

export function dropCowboyFromEnv(env: NodeJS.ProcessEnv = process.env): DropCowboyVoicemailDropProvider {
  const apiKey = env.DROPCOWBOY_API_KEY?.trim();
  const apiSecret = env.DROPCOWBOY_API_SECRET?.trim();
  const webhookSecret = env.DROPCOWBOY_WEBHOOK_SECRET?.trim();
  const missing = [
    !apiKey && "DROPCOWBOY_API_KEY",
    !apiSecret && "DROPCOWBOY_API_SECRET",
    !webhookSecret && "DROPCOWBOY_WEBHOOK_SECRET",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `VOICEMAIL_DROP_PROVIDER=dropcowboy but ${missing.join(", ")} not set`,
    );
  }
  return new DropCowboyVoicemailDropProvider({
    apiKey: apiKey!,
    apiSecret: apiSecret!,
    webhookSecret: webhookSecret!,
  });
}
