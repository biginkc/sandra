import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MariaCtiPanel } from "./maria-cti-panel";
const userId = "4904023124647936";
function setup() {
  const rendered = render(<MariaCtiPanel clientId="fixture-client" expectedUserId={userId} />);
  const iframe = screen.getByTitle("Maria Dialpad calling panel") as HTMLIFrameElement;
  const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
  const authenticate = (id: unknown = userId, authenticated = true, origin = "https://dialpad.com", source: MessageEventSource | null = iframe.contentWindow) => {
    fireEvent(window, new MessageEvent("message", { origin, source, data: {
      api: "opencti_dialpad", version: "1.0", method: "user_authentication",
      payload: { user_id: id, user_authenticated: authenticated },
    } }));
  };
  return { ...rendered, iframe, postMessage, authenticate };
}
describe("Maria CTI panel", () => {
  it("keeps the same iframe and browsing context mounted across collapse", () => {
    const h = setup(); const source = h.iframe.contentWindow;
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(h.iframe).toBeInTheDocument(); expect(h.iframe).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByTitle("Maria Dialpad calling panel")).toBe(h.iframe);
    expect(h.iframe.contentWindow).toBe(source); expect(h.iframe).toBeVisible();
    expect(h.postMessage).not.toHaveBeenCalled();
  });
  it("ignores wrong origins and other frames before permitting tab selection", () => {
    const h = setup(); const button = screen.getByRole("button", { name: "Use this Dialpad tab" });
    h.authenticate(userId, true, "https://evil.test"); expect(button).toBeDisabled();
    h.authenticate(userId, true, "https://dialpad.com", window); expect(button).toBeDisabled();
    h.authenticate(); expect(button).toBeEnabled();
    expect(h.postMessage).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(h.postMessage).toHaveBeenCalledExactlyOnceWith({ api: "opencti_dialpad", version: "1.0", method: "enable_current_tab" }, "https://dialpad.com");
    expect(screen.getByText("Tab selection requested. Audio readiness is not confirmed.")).toBeVisible();
  });
  it("revokes prior Maria authentication on trusted account switch or logout", () => {
    const h = setup(); const button = screen.getByRole("button", { name: "Use this Dialpad tab" });
    h.authenticate(); fireEvent.click(button); h.authenticate("999");
    expect(button).toBeDisabled(); expect(screen.queryByText(/Tab selection requested/)).not.toBeInTheDocument();
    h.authenticate(); expect(button).toBeEnabled(); h.authenticate(undefined, false);
    expect(button).toBeDisabled();
    expect(h.postMessage).toHaveBeenCalledTimes(1);
  });
  it("resets authentication on iframe load and never sends a call command", () => {
    const h = setup(); h.authenticate(); fireEvent.load(h.iframe);
    expect(screen.getByRole("button", { name: "Use this Dialpad tab" })).toBeDisabled();
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(h.iframe).toHaveAttribute("src", "https://dialpad.com/apps/fixture-client");
    expect(screen.queryByRole("button", { name: /start call|hang up/i })).not.toBeInTheDocument();
  });
});
