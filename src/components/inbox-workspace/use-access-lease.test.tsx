import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInboxAccessLease } from "./use-access-lease";
import type { InboxQueryIdentity } from "@/lib/inbox/workspace-query";
let identity: InboxQueryIdentity & { expiresAt: number };
function Probe() { return <p>{useInboxAccessLease(identity)}</p>; }
beforeEach(() => { vi.useFakeTimers(); identity = { orgId: "org", userId: "user", sessionId: "session", accessEpoch: "1", expiresAt: Date.now() + 60000 }; vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("does not extend a visibility lease when the authority transport fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(identity)).mockRejectedValue(Error("offline")));
  render(<Probe />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("valid")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(screen.getByText("valid")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText("unavailable")).toBeVisible();
});
it("distinguishes a confirmed revoked session from temporary network failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(identity)).mockResolvedValue(new Response(null, { status: 401 })));
  render(<Probe />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10001); });
  expect(screen.getByText("denied")).toBeVisible();
});
it("hides on tab visibility change and verifies identity again before restoring", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(identity)).mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher); render(<Probe />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.getByText("checking")).toBeVisible();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByText("checking")).toBeVisible();
});
it("rejects a new access epoch without showing cached private counts", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...identity, accessEpoch: "2" })));
  render(<Probe />); await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("denied")).toBeVisible();
});
