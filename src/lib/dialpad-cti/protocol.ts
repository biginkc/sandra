/**
 * Browser side of the Dialpad Mini Dialer postMessage protocol
 * (developers.dialpad.com/docs/dialpad-mini-dialer). Pure functions only, so
 * the origin/source/allowlist rules are unit-testable without a DOM.
 *
 * Facts taken from the official documentation:
 *  - the iframe is https://dialpad.com/apps/open and outgoing messages are
 *    posted with targetOrigin https://dialpad.com;
 *  - envelope: { api: 'opencti_dialpad', version: '1.0', method, payload? };
 *  - outgoing methods: initiate_call, enable_current_tab, hang_up_all_calls;
 *  - the iframe posts only user_authentication and call_ringing (inbound
 *    calls), both with targetOrigin '*', so the parent must check
 *    event.origin and event.source itself;
 *  - there is no outbound call-state message: connected/ended state comes from
 *    signed webhooks, never from this channel.
 */

export const DIALPAD_CTI_IFRAME_SRC = 'https://dialpad.com/apps/open';
export const DIALPAD_CTI_TARGET_ORIGIN = 'https://dialpad.com';
export const DIALPAD_CTI_IFRAME_ALLOW = 'microphone; speaker-selection; autoplay; camera; display-capture; hid';
export const DIALPAD_CTI_IFRAME_SANDBOX = 'allow-popups allow-scripts allow-same-origin allow-forms';
export const DIALPAD_CTI_API = 'opencti_dialpad';
export const DIALPAD_CTI_VERSION = '1.0';
export const DIALPAD_INCOMING_METHODS = ['user_authentication', 'call_ringing'] as const;
export const DIALPAD_CUSTOM_DATA_MAX = 2000;

export type DialpadIdentityKind = 'Office' | 'OfficeGroup' | 'CallCenter';

export interface DialpadDialPayload {
  phoneNumber: string;
  customData: string;
  identityType: DialpadIdentityKind | null;
  /** int64 in Dialpad; only ids that are exact JS integers can be sent from the browser. */
  identityId: number | null;
  outboundCallerId: string | null;
}

export type DialpadIncomingMessage =
  | { kind: 'user_authentication'; authenticated: boolean; userId: string | null }
  | { kind: 'call_ringing'; state: 'on' | 'off' | null }
  | { kind: 'ignored'; reason: 'source' | 'origin' | 'shape' | 'method' };

export interface DialpadMessageEventLike {
  origin: string;
  source: unknown;
  data: unknown;
}

/** The panel must refuse to operate unless the org's connection lists the fixed target origin. */
export function isDialpadTargetOriginConfigured(allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.includes(DIALPAD_CTI_TARGET_ORIGIN);
}

/**
 * Accepts a message only when it comes from the panel's own iframe window, from
 * an origin the connection allows, in the documented envelope, with an
 * allowlisted method. Anything else is ignored without inspecting its payload.
 */
export function parseDialpadIncomingMessage(
  event: DialpadMessageEventLike,
  context: { iframeWindow: unknown; allowedOrigins: readonly string[] },
): DialpadIncomingMessage {
  if (!context.iframeWindow || event.source !== context.iframeWindow) return { kind: 'ignored', reason: 'source' };
  if (!context.allowedOrigins.includes(event.origin)) return { kind: 'ignored', reason: 'origin' };
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'ignored', reason: 'shape' };
  const envelope = data as Record<string, unknown>;
  if (envelope.api !== DIALPAD_CTI_API || envelope.version !== DIALPAD_CTI_VERSION || typeof envelope.method !== 'string') {
    return { kind: 'ignored', reason: 'shape' };
  }
  const payload = envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
    ? (envelope.payload as Record<string, unknown>)
    : {};
  switch (envelope.method) {
    case 'user_authentication': {
      const authenticated = payload.user_authenticated === true;
      const rawId = payload.user_id;
      const userId = authenticated && typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId) : null;
      return { kind: 'user_authentication', authenticated: authenticated && userId !== null, userId };
    }
    case 'call_ringing':
      return { kind: 'call_ringing', state: payload.state === 'on' || payload.state === 'off' ? payload.state : null };
    default:
      return { kind: 'ignored', reason: 'method' };
  }
}

export interface DialpadOutgoingMessage {
  api: typeof DIALPAD_CTI_API;
  version: typeof DIALPAD_CTI_VERSION;
  method: 'enable_current_tab' | 'initiate_call';
  payload?: Record<string, unknown>;
}

export function buildEnableCurrentTabMessage(): DialpadOutgoingMessage {
  return { api: DIALPAD_CTI_API, version: DIALPAD_CTI_VERSION, method: 'enable_current_tab' };
}

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Builds the documented initiate_call payload from the server-released dial payload; throws on anything malformed. */
export function buildInitiateCallMessage(dial: DialpadDialPayload): DialpadOutgoingMessage {
  if (!E164.test(dial.phoneNumber)) throw new Error('Invalid phone number.');
  if (dial.customData.length === 0 || dial.customData.length > DIALPAD_CUSTOM_DATA_MAX) throw new Error('Invalid custom data.');
  const payload: Record<string, unknown> = {
    phone_number: dial.phoneNumber,
    enable_current_tab: true,
    custom_data: dial.customData,
  };
  if (dial.identityType !== null || dial.identityId !== null) {
    if (dial.identityType === null || dial.identityId === null || !Number.isSafeInteger(dial.identityId) || dial.identityId < 0) {
      throw new Error('Invalid caller identity.');
    }
    if (dial.outboundCallerId !== null) throw new Error('Caller identity and outbound caller id are mutually exclusive.');
    payload.identity_type = dial.identityType;
    payload.identity_id = dial.identityId;
  } else if (dial.outboundCallerId !== null) {
    if (!E164.test(dial.outboundCallerId)) throw new Error('Invalid outbound caller id.');
    payload.outbound_caller_id = dial.outboundCallerId;
  }
  return { api: DIALPAD_CTI_API, version: DIALPAD_CTI_VERSION, method: 'initiate_call', payload };
}

export interface DialpadPostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** Posts only to the fixed Dialpad origin; the target origin can never come from an incoming event. */
export function postToDialpad(target: DialpadPostTarget | null | undefined, message: DialpadOutgoingMessage): boolean {
  if (!target) return false;
  target.postMessage(message, DIALPAD_CTI_TARGET_ORIGIN);
  return true;
}
