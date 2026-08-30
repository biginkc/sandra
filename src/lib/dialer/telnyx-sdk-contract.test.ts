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
});
