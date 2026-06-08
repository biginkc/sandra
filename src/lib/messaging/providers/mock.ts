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
 * Two surface areas:
 *
 *   1. MessagingProvider — normal adapter methods (sendSms, verify, parse).
 *      Backwards-compatible with the original minimal mock: `sendSms`
 *      still returns `providerStatus: "sent"` immediately on the happy
 *      path, still throws on `FAIL` body prefix.
 *
 *   2. Simulation hooks — MODULE-LEVEL state exposed via named exports
 *      so tests can:
 *        - introspect every send (`getMockMessageLog()`)
 *        - register personas that auto-reply when the clock advances
 *          (`registerMockPersona()`, `getPendingMockReplies()`)
 *        - force specific failure classes (`FAIL-RATE_LIMIT`,
 *          `FAIL-CARRIER_BLOCK`)
 *        - reset between tests (`resetMockState()`)
 *
 *      Module-level state is shared across every `MockMessagingProvider`
 *      instance (the registry creates a fresh one each call), which is
 *      exactly what we want — app code hits the adapter via the registry,
 *      tests inspect the log from outside.
 *
 * `verifyWebhookSignature` returns true iff the X-Mock-Signature header
 * equals "valid". `parseInboundWebhook` accepts JSON of the shape
 * `{ externalId, from, to, body }` and flattens it into one event.
 */

// ---------------------------------------------------------------------------
// Types for the simulation surface
// ---------------------------------------------------------------------------

export type MockMessageState = "queued" | "sent" | "delivered" | "failed";

export type MockMessageEntry = {
  externalId: string;
  to: string;
  body: string;
  createdAt: Date;
  /**
   * Computed lazily from elapsed time since `createdAt` + fail reason.
   * The default timing is:
   *   0–500ms    → queued
   *   500–1000ms → sent
   *   >=1000ms   → delivered
   * A `failReason` short-circuits to "failed" at creation time.
   */
  state: MockMessageState;
  failReason?: MockFailReason;
  /** The raw SmsOutboundInput that produced this entry — for deep asserts. */
  input: SmsOutboundInput;
};

export type MockFailReason =
  | "generic"
  | "rate_limit"
  | "carrier_block"
  | "unknown_number";

/**
 * Personas drive the "what does the seller do when we text them?" side of
 * the simulation. Each persona maps an outbound message to zero or more
 * pending inbound replies, scheduled for a future time.
 *
 *   - responder    → polite yes-I'm-interested reply, +1h
 *   - opt_outer    → STOP, immediately after first outbound
 *   - ignorer      → never replies
 *   - complainer   → angry rejection, +15m
 *   - delayed      → positive reply, +3d
 */
export type MockPersona =
  | "responder"
  | "opt_outer"
  | "ignorer"
  | "complainer"
  | "delayed";

export type MockPendingReply = {
  from: string;
  to: string;
  body: string;
  scheduledFor: Date;
  /** Incremental id so tests can correlate reply → source message. */
  id: string;
};

// ---------------------------------------------------------------------------
// Module-level state (shared across all MockMessagingProvider instances)
// ---------------------------------------------------------------------------

type StoredMessage = {
  externalId: string;
  to: string;
  body: string;
  createdAt: Date;
  failReason?: MockFailReason;
  input: SmsOutboundInput;
};

const messageLog: StoredMessage[] = [];
const personas = new Map<string, MockPersona>();
const pendingReplies: MockPendingReply[] = [];
let replyCounter = 0;
/** Track which phones have been sent to at least once — used by
 *  opt_outer so the STOP reply only fires once per enrollment. */
const firstSendSeen = new Set<string>();

// ---------------------------------------------------------------------------
// Public simulation API
// ---------------------------------------------------------------------------

/** Reset every piece of mock state. Call from `beforeEach` in tests. */
export function resetMockState(): void {
  messageLog.length = 0;
  personas.clear();
  pendingReplies.length = 0;
  replyCounter = 0;
  firstSendSeen.clear();
}

/**
 * Register a persona for a phone number. Later `sendSms` calls to that
 * number schedule the persona's reply into `pendingReplies`.
 */
export function registerMockPersona(phone: string, persona: MockPersona): void {
  personas.set(phone, persona);
}

/** Return the full outbound log with computed states. */
export function getMockMessageLog(): MockMessageEntry[] {
  const now = new Date();
  return messageLog.map((m) => ({
    externalId: m.externalId,
    to: m.to,
    body: m.body,
    createdAt: m.createdAt,
    input: m.input,
    failReason: m.failReason,
    state: computeState(m, now),
  }));
}

/** Replies whose scheduledFor is <= now. Safe to post each one to the
 *  Dialpad inbound webhook for end-to-end sequence simulation. */
export function getPendingMockReplies(): MockPendingReply[] {
  const now = new Date();
  return pendingReplies.filter((r) => r.scheduledFor.getTime() <= now.getTime());
}

/** Remove the given reply ids (or all if omitted) from the pending queue. */
export function clearPendingMockReplies(ids?: readonly string[]): void {
  if (!ids) {
    pendingReplies.length = 0;
    return;
  }
  const set = new Set(ids);
  for (let i = pendingReplies.length - 1; i >= 0; i--) {
    if (set.has(pendingReplies[i].id)) pendingReplies.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeState(msg: StoredMessage, now: Date): MockMessageState {
  if (msg.failReason) return "failed";
  const elapsed = now.getTime() - msg.createdAt.getTime();
  if (elapsed < 500) return "queued";
  if (elapsed < 1000) return "sent";
  return "delivered";
}

/**
 * Parse a force-fail marker out of the body. Any body starting with
 * `FAIL-RATE_LIMIT`, `FAIL-CARRIER_BLOCK`, or `FAIL-UNKNOWN_NUMBER`
 * gets the specific reason; plain `FAIL` stays generic (matches the
 * original mock behavior).
 */
function parseFailReason(body: string): MockFailReason | null {
  const upper = body.toUpperCase();
  if (upper.startsWith("FAIL-RATE_LIMIT")) return "rate_limit";
  if (upper.startsWith("FAIL-CARRIER_BLOCK")) return "carrier_block";
  if (upper.startsWith("FAIL-UNKNOWN_NUMBER")) return "unknown_number";
  if (upper.startsWith("FAIL")) return "generic";
  return null;
}

function schedulePersonaReply(toNumber: string, ourNumber: string): void {
  const persona = personas.get(toNumber);
  if (!persona || persona === "ignorer") return;

  const id = `mock_reply_${++replyCounter}`;
  const now = new Date();

  let body: string;
  let delayMs: number;
  switch (persona) {
    case "responder":
      body = "Yeah, I'm interested — what's the offer?";
      delayMs = 60 * 60 * 1000; // 1h
      break;
    case "opt_outer":
      // Only fire STOP once per phone; prevents double-STOP if a sequence
      // fires multiple outbounds after the opt-out.
      if (firstSendSeen.has(toNumber)) return;
      body = "STOP";
      delayMs = 1000; // near-immediate
      break;
    case "complainer":
      body = "Stop texting me, not interested";
      delayMs = 15 * 60 * 1000; // 15m
      break;
    case "delayed":
      body = "Hey, sorry for the delay — yes still looking to sell";
      delayMs = 3 * 24 * 60 * 60 * 1000; // 3d
      break;
    default:
      return;
  }

  pendingReplies.push({
    id,
    from: toNumber,
    to: ourNumber,
    body,
    scheduledFor: new Date(now.getTime() + delayMs),
  });
}

// ---------------------------------------------------------------------------
// MessagingProvider implementation
// ---------------------------------------------------------------------------

export class MockMessagingProvider implements MessagingProvider {
  readonly providerId = "mock";

  getDefaultFromNumber(): string | null {
    return "+15551234567";
  }

  async sendSms(input: SmsOutboundInput): Promise<SmsSendResult> {
    const failReason = parseFailReason(input.body);
    const externalId = `mock_${input.to}_${simpleHash(input.body)}`;
    const createdAt = new Date();

    // Log every attempt, even failures — tests need to see what got tried.
    messageLog.push({
      externalId,
      to: input.to,
      body: input.body,
      createdAt,
      failReason: failReason ?? undefined,
      input,
    });

    if (failReason === "generic") {
      throw new Error("mock provider: forced failure");
    }
    if (failReason === "rate_limit") {
      throw new Error("mock provider: 429 rate limit");
    }
    if (failReason === "carrier_block") {
      throw new Error("mock provider: carrier blocked recipient");
    }
    if (failReason === "unknown_number") {
      throw new Error("mock provider: unknown recipient number");
    }

    // Happy path — schedule the persona reply if one is registered.
    schedulePersonaReply(input.to, input.from ?? "+15551234567");
    firstSendSeen.add(input.to);

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
