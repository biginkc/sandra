import { describe, expect, it } from "vitest";
import { DIALPAD_CTI_ORIGIN, dialpadCtiEnableCurrentTabMessage, parseDialpadCtiEvent } from "./cti-protocol";
const source = {};
const userId = "4904023124647936";
const auth = { api: "opencti_dialpad", version: "1.0", method: "user_authentication", payload: { user_id: userId, user_authenticated: true } };
const envelope = (data: unknown = auth) => ({ origin: DIALPAD_CTI_ORIGIN, source, data });
describe("Dialpad CTI UI boundary", () => {
  it("accepts exact-frame configured-user authentication and logout", () => {
    expect(parseDialpadCtiEvent(envelope(), source, userId)).toEqual({ type: "authentication", authenticated: true, userId });
    expect(parseDialpadCtiEvent(envelope({ ...auth, payload: { user_id: Number(userId), user_authenticated: false } }), source, userId)).toEqual({ type: "authentication", authenticated: false, userId });
  });
  it("rejects wrong origin, frame, or missing frame", () => {
    for (const origin of ["http://dialpad.com", "https://dialpad.com.evil.test", "null", "https://dialpad.com/"]) {
      expect(parseDialpadCtiEvent({ ...envelope(), origin }, source, userId)).toBeNull();
    }
    expect(parseDialpadCtiEvent({ ...envelope(), source: {} }, source, userId)).toBeNull();
    expect(parseDialpadCtiEvent({ ...envelope(), source: null }, null, userId)).toBeNull();
  });
  it("revokes authentication for other users and unsafe numeric identities", () => {
    for (const id of ["1", Number.MAX_SAFE_INTEGER + 1, {}, null]) {
      expect(parseDialpadCtiEvent(envelope({ ...auth, payload: { user_id: id, user_authenticated: true } }), source, userId)).toEqual({ type: "authentication", authenticated: false, userId: null });
    }
  });
  it("revokes a prior Maria login when the trusted frame logs out without a user ID", () => {
    expect(parseDialpadCtiEvent(envelope(), source, userId)).toMatchObject({ authenticated: true });
    expect(parseDialpadCtiEvent(envelope({ ...auth, payload: { user_authenticated: false } }), source, userId)).toEqual({ type: "authentication", authenticated: false, userId: null });
  });
  it("rejects malformed messages and undocumented API/version/method", () => {
    for (const data of [null, [], "{}", { ...auth, api: "other" }, { ...auth, version: 1 }, { ...auth, version: "2.0" }, { ...auth, method: "hangup" }, { ...auth, payload: { user_id: userId, user_authenticated: "true" } }]) {
      expect(parseDialpadCtiEvent(envelope(data), source, userId)).toBeNull();
    }
  });
  it("parses ringing on/off only for the configured user and preserves large string call IDs", () => {
    const payload = { id: "9007199254740993", state: "on", target: { id: userId, type: "User" } };
    const data = { ...auth, method: "call_ringing", payload };
    expect(parseDialpadCtiEvent(envelope(data), source, userId)).toEqual({ type: "ringing", ringing: true, callId: payload.id, userId });
    expect(parseDialpadCtiEvent(envelope({ ...data, payload: { ...payload, state: "off" } }), source, userId)).toMatchObject({ ringing: false });
    for (const patch of [{ state: "connected" }, { id: Number.MAX_SAFE_INTEGER + 1 }, { target: { id: userId, type: "CallCenter" } }, { target: { id: "1", type: "User" } }]) {
      expect(parseDialpadCtiEvent(envelope({ ...data, payload: { ...payload, ...patch } }), source, userId)).toBeNull();
    }
  });
  it("builds only the documented enable-current-tab command without a payload", () => {
    expect(dialpadCtiEnableCurrentTabMessage()).toEqual({ api: "opencti_dialpad", version: "1.0", method: "enable_current_tab" });
  });
});
