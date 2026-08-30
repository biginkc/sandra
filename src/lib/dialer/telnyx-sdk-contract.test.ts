import { describe, expect, it, vi } from "vitest";

import { TelnyxRTC } from "@telnyx/webrtc";

describe("pinned Telnyx SDK recovery contract", () => {
  it("socketDisconnect closes only signaling and preserves calls without hangup or BYE", () => {
    const hangup = vi.fn();
    const activeCall = { id: "active-browser-leg", hangup };
    const closeConnection = vi.fn();
    const session = {
      calls: { "active-browser-leg": activeCall },
      _closeConnection: closeConnection,
    };

    const socketDisconnect = (
      TelnyxRTC.prototype as unknown as { socketDisconnect(this: typeof session): void }
    ).socketDisconnect;
    expect(typeof socketDisconnect).toBe("function");
    socketDisconnect.call(session);

    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(hangup).not.toHaveBeenCalled();
    expect(session.calls["active-browser-leg"]).toBe(activeCall);
  });

  it("serverDisconnect purges local calls without sending BYE or preserving auto-reconnect", async () => {
    const hangup = vi.fn(async () => undefined);
    const setState = vi.fn();
    const cleanupNetworkListeners = vi.fn();
    const closeConnection = vi.fn();
    const session = {
      calls: { "active-browser-leg": { id: "active-browser-leg", hangup, setState } },
      _cleanupNetworkListeners: cleanupNetworkListeners,
      _clearTokenExpiryTimeout: vi.fn(),
      _drainCallReportUploads: vi.fn(async () => undefined),
      _detachListeners: vi.fn(),
      _closeConnection: closeConnection,
      _autoReconnect: true,
      connection: { close: closeConnection },
    };
    const serverDisconnect = (
      TelnyxRTC.prototype as unknown as { serverDisconnect(this: typeof session): Promise<void> }
    ).serverDisconnect;

    await serverDisconnect.call(session);

    expect(setState).toHaveBeenCalled();
    expect(hangup).toHaveBeenCalledWith(
      expect.objectContaining({ initiator: "sdk:server-disconnect" }),
      false,
    );
    expect(session.calls).toEqual({});
    expect(cleanupNetworkListeners).toHaveBeenCalledTimes(1);
  });
});
