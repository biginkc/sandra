/** Dialpad CTI browser UI messages only; never acquisition or terminal evidence.
 * Contract: https://developers.dialpad.com/docs/dialpad-mini-dialer
 */
export const DIALPAD_CTI_ORIGIN = "https://dialpad.com";
const API = "opencti_dialpad";
const VERSION = "1.0";

export type DialpadCtiEvent =
  | { type: "authentication"; authenticated: boolean; userId: string | null }
  | { type: "ringing"; ringing: boolean; callId: string; userId: string };

type MessageEnvelope = { origin: string; source: unknown; data: unknown };
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function identifier(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

/** Call with the current iframe.contentWindow, not a window supplied by a message.
 * Unknown users and group targets cannot establish the configured rep's UI state.
 */
export function parseDialpadCtiEvent(
  event: MessageEnvelope,
  expectedSource: unknown,
  expectedUserId: string,
): DialpadCtiEvent | null {
  if (!expectedSource || event.origin !== DIALPAD_CTI_ORIGIN || event.source !== expectedSource ||
    identifier(expectedUserId) !== expectedUserId) return null;
  const message = object(event.data);
  if (!message || message.api !== API || message.version !== VERSION) return null;
  const payload = object(message.payload);
  if (!payload) return null;
  if (message.method === "user_authentication") {
    const userId = identifier(payload.user_id);
    if (typeof payload.user_authenticated !== "boolean") return null;
    // A trusted frame switching accounts must revoke previously confirmed UI auth.
    if (userId !== expectedUserId) return { type: "authentication", authenticated: false, userId: null };
    return { type: "authentication", authenticated: payload.user_authenticated, userId };
  }
  if (message.method === "call_ringing") {
    const target = object(payload.target);
    const userId = identifier(target?.id);
    const callId = identifier(payload.id);
    if (userId !== expectedUserId || !callId || typeof target?.type !== "string" ||
      target.type.toLowerCase() !== "user" || (payload.state !== "on" && payload.state !== "off")) return null;
    return { type: "ringing", ringing: payload.state === "on", callId, userId };
  }
  return null;
}

/** The only outbound command supported here. Caller sends to DIALPAD_CTI_ORIGIN.
 * Selecting the CTI tab does not prove media readiness or initiate a call.
 */
export function dialpadCtiEnableCurrentTabMessage() {
  return { api: API, version: VERSION, method: "enable_current_tab" } as const;
}
