import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInboxActionRecovery } from "./use-action-recovery";
const identity = { orgId: "org", userId: "user", sessionId: "session", accessEpoch: "1" };
const pair = { preparationId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "22222222-2222-4222-8222-222222222222" };
const operation = { operationId: "33333333-3333-4333-8333-333333333333", acceptedAt: "2026-09-13T23:00:00Z" };
const key = `inbox-action-recovery:${JSON.stringify(Object.values(identity))}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const options = () => ({ identity, enabled: true, onRecovered: vi.fn(), onExpired: vi.fn(), onAccessLost: vi.fn() });
beforeEach(() => sessionStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("opaque bulk action recovery", () => {
  it("restores only the exact identity's original pair and retains it until receipt completion", async () => {
    sessionStorage.setItem(key, JSON.stringify(pair));
    const fetcher = vi.fn().mockResolvedValue(response({ state: "accepted", operation })); vi.stubGlobal("fetch", fetcher);
    const config = options(); const hook = renderHook(() => useInboxActionRecovery(config));
    await waitFor(() => expect(config.onRecovered).toHaveBeenCalledWith(operation));
    const url = new URL(fetcher.mock.calls[0][0], "http://localhost"); expect(Object.fromEntries(url.searchParams)).toEqual(pair);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(pair);
    act(() => hook.result.current.completed()); expect(sessionStorage.getItem(key)).toBeNull();
  });
  it("keeps pending acceptance blocked until authoritative expiry releases that same pair", async () => {
    sessionStorage.setItem(key, JSON.stringify(pair));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ state: "pending", operation: null })).mockResolvedValueOnce(response({ state: "expired_not_accepted", operation: null })));
    const config = options(); const hook = renderHook(() => useInboxActionRecovery(config));
    await waitFor(() => expect(hook.result.current.panel?.props["aria-label"]).toBe("Recover earlier bulk action"));
    expect(hook.result.current.blocked).toBe(true); expect(sessionStorage.getItem(key)).not.toBeNull();
    await act(async () => hook.result.current.check(pair));
    await waitFor(() => expect(config.onExpired).toHaveBeenCalledOnce()); expect(hook.result.current.blocked).toBe(false); expect(sessionStorage.getItem(key)).toBeNull();
  });
  it("does not restore another identity's record", async () => {
    sessionStorage.setItem(key, JSON.stringify(pair)); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const config = options(); const hook = renderHook(() => useInboxActionRecovery({ ...config, identity: { ...identity, sessionId: "other" } }));
    await waitFor(() => expect(hook.result.current.blocked).toBe(false)); expect(fetcher).not.toHaveBeenCalled(); expect(sessionStorage.getItem(key)).not.toBeNull();
  });
  it("stores no messages, labels, or selection in the recovery record", () => {
    const hook = renderHook(() => useInboxActionRecovery(options())); act(() => { hook.result.current.remember(pair); });
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(pair); expect(Object.keys(JSON.parse(sessionStorage.getItem(key)!))).toHaveLength(2);
  });
  it("ignores a late accepted response after unmount", async () => {
    sessionStorage.setItem(key, JSON.stringify(pair)); let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const config = options(); const hook = renderHook(() => useInboxActionRecovery(config)); hook.unmount();
    await act(async () => finish(response({ state: "accepted", operation }))); expect(config.onRecovered).not.toHaveBeenCalled(); expect(sessionStorage.getItem(key)).not.toBeNull();
  });
  it("reports confirmed access loss without treating an uncertain operation as rejected", async () => {
    sessionStorage.setItem(key, JSON.stringify(pair)); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 403)));
    const config = options(); renderHook(() => useInboxActionRecovery(config)); await waitFor(() => expect(config.onAccessLost).toHaveBeenCalledOnce());
    expect(config.onExpired).not.toHaveBeenCalled(); expect(sessionStorage.getItem(key)).not.toBeNull();
  });
});
it("access cleanup retains an ambiguous pair and suspends new actions until remount recovery", async () => {
  sessionStorage.setItem(key, JSON.stringify(pair));
  const fetcher = vi.fn().mockResolvedValueOnce(response({ state: "pending", operation: null })).mockResolvedValueOnce(response({ state: "accepted", operation })); vi.stubGlobal("fetch", fetcher);
  const config = options(); const first = renderHook(() => useInboxActionRecovery(config));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  act(() => first.result.current.clear()); expect(first.result.current.blocked).toBe(true); expect(first.result.current.panel).toBeUndefined(); expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(pair);
  first.unmount(); renderHook(() => useInboxActionRecovery(config)); await waitFor(() => expect(config.onRecovered).toHaveBeenCalledWith(operation));
  expect(fetcher.mock.calls[1][0]).toContain(pair.idempotencyKey);
});
