"use client";

export type DirectWatchdogPresence = { close(graceful?: boolean): Promise<void> };
type PresenceMessage = { type?: string };

const ACK_TIMEOUT_MS = 2_500;
const CLOSE_TIMEOUT_MS = 1_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

/**
 * Presence admission is required before the browser answers its inbound leg.
 * Once admitted, the server owns the liveness clock through WebSocket ping/pong.
 * Reconnects are bounded by the signed lease expiry; they never revive a fenced
 * or expired call because attach is checked again by the server on every socket.
 */
export function openDirectWatchdogPresence(config: { url: string; token: string }): Promise<DirectWatchdogPresence> {
  const expiresAtMs = tokenExpiry(config.token);
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let closed = false;
  let admissionRejected = false;
  let initialSettled = false;
  let initialResolve: ((presence: DirectWatchdogPresence) => void) | undefined;
  let initialReject: ((error: Error) => void) | undefined;

  const clearCloseTimer = () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = undefined;
  };

  const rejectInitial = (error: unknown) => {
    if (initialSettled) return;
    initialSettled = true;
    clearCloseTimer();
    initialReject?.(error instanceof Error ? error : new Error("Call safety monitoring connection failed."));
  };

  const settleInitial = (presence: DirectWatchdogPresence) => {
    if (initialSettled) return;
    initialSettled = true;
    clearCloseTimer();
    initialResolve?.(presence);
  };

  const boundedClose = (graceful = true): Promise<void> => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    clearCloseTimer();
    const current = socket;
    if (!current || current.readyState === WebSocket.CLOSED) return Promise.resolve();
    if (current.readyState === WebSocket.CLOSING) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        current.removeEventListener("close", finish);
        resolve();
      };
      const timeout = setTimeout(finish, CLOSE_TIMEOUT_MS);
      current.addEventListener("close", finish, { once: true });
      try {
        current.close(graceful ? 1000 : 4002, graceful ? "call ended" : "browser lost");
      } catch {
        finish();
      }
    });
  };

  const presence: DirectWatchdogPresence = { close: boundedClose };

  const scheduleReconnect = () => {
    if (closed || admissionRejected || Date.now() >= expiresAtMs || reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect(false);
    }, delay);
  };

  const failAdmission = (error: unknown) => {
    admissionRejected = true;
    rejectInitial(error);
    void boundedClose(false);
  };

  const handleClose = (closedSocket: WebSocket, code: number) => {
    if (socket !== closedSocket) return;
    socket = null;
    clearCloseTimer();
    if (!initialSettled) {
      rejectInitial(new Error("Call safety monitoring closed before admission."));
      return;
    }
    if (closed || admissionRejected || Date.now() >= expiresAtMs || code === 4401 || code === 4403) return;
    scheduleReconnect();
  };

  const connect = async (initial: boolean): Promise<void> => {
    if (closed || admissionRejected || Date.now() >= expiresAtMs) {
      if (initial) rejectInitial(new Error("Call safety monitoring lease expired."));
      return;
    }
    let current: WebSocket;
    try {
      current = new WebSocket(config.url);
    } catch (error) {
      if (initial) failAdmission(error); else scheduleReconnect();
      return;
    }
    socket = current;
    let acked = false;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const clearAckTimer = () => {
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = undefined;
    };
    const timeoutAdmission = () => {
      clearAckTimer();
      if (!acked && current === socket) {
        if (initial) failAdmission(new Error("Call safety monitoring did not acknowledge the browser."));
        else {
          try { current.close(4003, "presence acknowledgement timeout"); } catch { /* already closed */ }
        }
      }
    };
    // Start at construction, rather than on open, so DNS/TCP/TLS stalls cannot
    // hold a call start forever.
    ackTimer = setTimeout(timeoutAdmission, ACK_TIMEOUT_MS);
    current.addEventListener("open", () => {
      try { current.send(JSON.stringify({ type: "auth", token: config.token })); }
      catch (error) { if (initial) failAdmission(error); }
    });
    current.addEventListener("message", (event) => {
      let message: PresenceMessage;
      try { message = JSON.parse(String(event.data)) as PresenceMessage; }
      catch { if (initial) failAdmission(new Error("Invalid call safety response.")); return; }
      if (!acked && message.type === "presence_ack") {
        acked = true;
        clearAckTimer();
        reconnectAttempt = 0;
        settleInitial(presence);
        return;
      }
      if (message.type === "error") {
        if (initial) failAdmission(new Error("Call safety monitoring rejected the browser."));
        else { admissionRejected = true; void boundedClose(false); }
      }
    });
    current.addEventListener("error", () => {
      if (!acked && initial) failAdmission(new Error("Call safety monitoring connection failed."));
    });
    current.addEventListener("close", (event) => {
      clearAckTimer();
      handleClose(current, event.code);
    });
  };

  const promise = new Promise<DirectWatchdogPresence>((resolve, reject) => {
    initialResolve = resolve;
    initialReject = reject;
    void connect(true);
  });
  return promise;
}

function tokenExpiry(token: string): number {
  try {
    const body = token.split(".")[0];
    if (!body) return 0;
    const encoded = body.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(body.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(encoded)) as { exp?: unknown; expiresAtMs?: unknown };
    const expiry = typeof parsed.expiresAtMs === "number" ? parsed.expiresAtMs : typeof parsed.exp === "number" ? parsed.exp : 0;
    return Number.isFinite(expiry) ? expiry : 0;
  } catch {
    return 0;
  }
}
