import type {
  DialpadFromOption,
  MessagingProvider,
  SmsInboundEvent,
  SmsOutboundInput,
  SmsSendResult,
} from "../types";

/**
 * Deterministic fake messaging provider. Gated by MESSAGING_PROVIDER=mock
 * in `.env.test.local` via `vitest.integration.config.ts`, and can be
 * toggled in `.env.local` to drive the UI without real Dialpad creds.
 *
 * Behaviors keyed off body prefix so tests can force outcomes:
 *  - body starts with "FAIL" → sendSms throws (provider error path)
 *  - otherwise              → returns a stable externalId derived from body
 *
 * `verifyWebhookSignature` returns true iff the X-Mock-Signature header
 * equals "valid". `parseInboundWebhook` accepts JSON of the shape
 * `{ externalId, from, to, body }` and flattens it into one event.
 */
export class MockMessagingProvider implements MessagingProvider {
  readonly providerId = "mock";

  async sendSms(input: SmsOutboundInput): Promise<SmsSendResult> {
    if (input.body.toUpperCase().startsWith("FAIL")) {
      throw new Error("mock provider: forced failure");
    }
    // Stable id per (to, body) tuple — simplifies dedup assertions in tests.
    const externalId = `mock_${input.to}_${simpleHash(input.body)}`;
    return Promise.resolve({
      externalId,
      providerStatus: "sent",
      raw: { mock: true, input },
    });
  }

  verifyWebhookSignature(_rawBody: string, headers: Headers): boolean {
    return headers.get("x-mock-signature") === "valid";
  }

  async listFromNumbers(): Promise<DialpadFromOption[]> {
    return Promise.resolve([
      {
        number: "+15551234567",
        ownerName: "(mock) Office",
        ownerType: "office",
        status: "office",
      },
      {
        number: "+15559999999",
        ownerName: "(mock) Unassigned",
        ownerType: "available",
        status: "available",
      },
    ]);
  }

  parseInboundWebhook(rawBody: string): SmsInboundEvent[] {
    const obj = JSON.parse(rawBody) as {
      externalId?: string;
      from?: string;
      to?: string;
      body?: string;
      mediaUrls?: string[];
    };
    if (!obj.externalId || !obj.from || !obj.to || obj.body == null) {
      throw new Error(
        "mock provider: payload must include externalId, from, to, body",
      );
    }
    return [
      {
        externalId: obj.externalId,
        from: obj.from,
        to: obj.to,
        body: obj.body,
        receivedAt: new Date(),
        mediaUrls: obj.mediaUrls,
        raw: obj,
      },
    ];
  }
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}
