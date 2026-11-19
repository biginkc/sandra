import type {
  VoicemailDropProvider,
  VoicemailDropSendInput,
  VoicemailDropSendResult,
  WebhookHeaders,
} from "../types";
import { parseDropCowboyCallback, parseDropCowboyStatusWebhook } from "../webhook";

/**
 * Deterministic in-memory provider for tests (VOICEMAIL_DROP_PROVIDER=mock).
 * Module-level state so tests can inspect sends made via the registry.
 *
 * - Every send is logged (`getMockVoicemailDropLog()`).
 * - `setMockVoicemailDropResult(result)` forces the next sends' result;
 *   default is accepted (202).
 * - Signature is valid iff header `x-mock-signature` equals "valid".
 * - Parsers accept the Drop Cowboy payload shapes.
 */

export type MockVoicemailDropEntry = { input: VoicemailDropSendInput; result: VoicemailDropSendResult };

let log: MockVoicemailDropEntry[] = [];
let forced: VoicemailDropSendResult | null = null;
let counter = 0;

export function getMockVoicemailDropLog(): readonly MockVoicemailDropEntry[] {
  return log;
}

export function setMockVoicemailDropResult(result: VoicemailDropSendResult | null): void {
  forced = result;
}

export function resetMockVoicemailDropState(): void {
  log = [];
  forced = null;
  counter = 0;
}

function headerValue(headers: WebhookHeaders, name: string): string | null {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name);
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  }
  return null;
}

export class MockVoicemailDropProvider implements VoicemailDropProvider {
  readonly id = "mock" as const;

  async sendDrop(input: VoicemailDropSendInput): Promise<VoicemailDropSendResult> {
    const result: VoicemailDropSendResult = forced ?? {
      outcome: "accepted",
      httpStatus: 202,
      messageId: `mock-msg-${++counter}`,
      raw: { status: "queued" },
    };
    log.push({ input, result });
    return result;
  }

  verifyWebhookSignature(_rawBody: string, headers: WebhookHeaders) {
    return headerValue(headers, "x-mock-signature") === "valid"
      ? ({ valid: true } as const)
      : ({ valid: false, reason: "mismatch" } as const);
  }

  parseStatusWebhook(rawBody: string) {
    return parseDropCowboyStatusWebhook(rawBody);
  }

  parseCallback(rawBody: string) {
    return parseDropCowboyCallback(rawBody);
  }
}
