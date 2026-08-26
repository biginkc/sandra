import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BroadcastHandler = (message: { payload: unknown }) => void;
type SubscribeCallback = (status: REALTIME_SUBSCRIBE_STATES) => void;

type MockChannel = {
  on: (type: string, filter: unknown, handler: BroadcastHandler) => MockChannel;
  subscribe: (cb: SubscribeCallback) => MockChannel;
  _broadcastHandler: BroadcastHandler | null;
  _subscribeCallback: SubscribeCallback | null;
};

const { getSession, setAuth, removeChannel, channelSpy } = vi.hoisted(() => ({
  getSession: vi.fn(),
  setAuth: vi.fn(),
  removeChannel: vi.fn(),
  channelSpy: vi.fn(),
}));

let channels: MockChannel[] = [];

function makeMockChannel(): MockChannel {
  const channel: MockChannel = {
    _broadcastHandler: null,
    _subscribeCallback: null,
    on(_type, _filter, handler) {
      channel._broadcastHandler = handler;
      return channel;
    },
    subscribe(cb) {
      channel._subscribeCallback = cb;
      return channel;
    },
  };
  return channel;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession },
    realtime: { setAuth },
    channel: (name: string, opts: unknown) => {
      channelSpy(name, opts);
      const channel = makeMockChannel();
      channels.push(channel);
      return channel;
    },
    removeChannel,
  }),
}));

import { useCoachChannel } from "./use-coach-channel";

function latestChannel(): MockChannel {
  const channel = channels[channels.length - 1];
  if (!channel) throw new Error("No channel created yet");
  return channel;
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useCoachChannel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    channels = [];
    getSession.mockReset().mockResolvedValue({ data: { session: { access_token: "tok" } } });
    setAuth.mockReset();
    removeChannel.mockReset();
    channelSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to a private channel keyed by call id", async () => {
    renderHook(() => useCoachChannel("call-123"));
    await flush();
    expect(channelSpy).toHaveBeenCalledWith("coach:call-123", { config: { private: true } });
    expect(setAuth).toHaveBeenCalledWith("tok");
  });

  it("reduces an incoming broadcast event into state and is not degraded while events keep arriving", async () => {
    const { result } = renderHook(() => useCoachChannel("call-123"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.degraded).toBe(false);

    act(() => latestChannel()._broadcastHandler?.({ payload: { type: "phase", phaseId: "reveal", ts: "t1" } }));
    expect(result.current.state.currentPhaseId).toBe("reveal");
    expect(result.current.degraded).toBe(false);
  });

  it("goes degraded after 15s of silence even with no explicit status change (rolling watchdog)", async () => {
    const { result } = renderHook(() => useCoachChannel("call-123"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(result.current.degraded).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(result.current.degraded).toBe(true);
  });

  it("re-arms the liveness window on every event — degraded is a rolling check, not one-shot", async () => {
    const { result } = renderHook(() => useCoachChannel("call-123"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    act(() => latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 1, ts: "t1" } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // 20s of wall-clock time passed, but the event at 10s reset the window,
    // so only 10s has elapsed since the last event — still not degraded.
    expect(result.current.degraded).toBe(false);
  });

  it("goes degraded immediately on CHANNEL_ERROR and resubscribes with backoff", async () => {
    const { result } = renderHook(() => useCoachChannel("call-999"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    expect(result.current.degraded).toBe(true);

    const channelCountBeforeBackoff = channels.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(channels.length).toBeGreaterThan(channelCountBeforeBackoff);
    expect(removeChannel).toHaveBeenCalled();
  });

  it("goes degraded on TIMED_OUT and CLOSED too", async () => {
    for (const status of [REALTIME_SUBSCRIBE_STATES.TIMED_OUT, REALTIME_SUBSCRIBE_STATES.CLOSED]) {
      const { result, unmount } = renderHook(() => useCoachChannel(`call-${status}`));
      await flush();
      act(() => latestChannel()._subscribeCallback?.(status));
      expect(result.current.degraded).toBe(true);
      unmount();
    }
  });

  it("tears down the channel on unmount", async () => {
    const { unmount } = renderHook(() => useCoachChannel("call-teardown"));
    await flush();
    unmount();
    expect(removeChannel).toHaveBeenCalled();
  });

  it("does nothing when callId is null", async () => {
    renderHook(() => useCoachChannel(null));
    await flush();
    expect(channelSpy).not.toHaveBeenCalled();
  });

  it("cancels a queued resubscribe timer if the channel recovers on its own before it fires", async () => {
    renderHook(() => useCoachChannel("call-race"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    const channelCountAfterError = channels.length;
    // The channel recovers on its own (same instance) before the queued
    // backoff timer fires.
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000); // past the first backoff delay
    });
    // No new channel should have been created — the stale resubscribe was
    // cancelled instead of tearing down the connection that just recovered.
    expect(channels.length).toBe(channelCountAfterError);
    expect(removeChannel).not.toHaveBeenCalled();
  });

  it("marks reconnectGap on a real reconnect (a SUBSCRIBED after an error), not on the first subscribe", async () => {
    const { result } = renderHook(() => useCoachChannel("call-gap"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.reconnectGap).toBe(false);

    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.reconnectGap).toBe(true);
  });

  it("clears reconnectGap once a fresh valid event arrives", async () => {
    const { result } = renderHook(() => useCoachChannel("call-gap-clear"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.reconnectGap).toBe(true);

    act(() => latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 2, ts: "t1" } }));
    expect(result.current.reconnectGap).toBe(false);
  });

  it("dismissReconnectGap clears it manually", async () => {
    const { result } = renderHook(() => useCoachChannel("call-gap-dismiss"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.reconnectGap).toBe(true);

    act(() => result.current.dismissReconnectGap());
    expect(result.current.reconnectGap).toBe(false);
  });

  it("drops a malformed event, counts it, and never dispatches it into state", async () => {
    const { result } = renderHook(() => useCoachChannel("call-bad"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "phase", phaseId: "not_a_real_phase", ts: "t1" } }),
    );
    expect(result.current.malformedEventCount).toBe(1);
    expect(result.current.state.currentPhaseId).toBe("introduction");
  });

  it("tolerates an unknown event type (producer forward-compat) without counting it as malformed", async () => {
    const { result } = renderHook(() => useCoachChannel("call-unknown-type"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({
        payload: { type: "deal_update", offerPrice: "$210,000", ts: "t1" },
      }),
    );
    expect(result.current.malformedEventCount).toBe(0);
  });

  it("dispatches a coach_note event into nudges — first-class, not dropped", async () => {
    const { result } = renderHook(() => useCoachChannel("call-note"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({
        payload: { type: "coach_note", text: "Never open with 'How are you doing today?'", phaseId: "introduction", ts: "t1" },
      }),
    );
    expect(result.current.state.nudges).toHaveLength(1);
    expect(result.current.malformedEventCount).toBe(0);
  });

  it("scriptOutOfSync stays null while events report the loaded script's own version", async () => {
    const { result } = renderHook(() => useCoachChannel("call-version-ok"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 1, ts: "t1", scriptVersion: "1.0.1" } }),
    );
    expect(result.current.scriptOutOfSync).toBeNull();
  });

  it("scriptOutOfSync flags the remote version the moment an event reports a mismatch", async () => {
    const { result } = renderHook(() => useCoachChannel("call-version-mismatch"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 1, ts: "t1", scriptVersion: "0.9.0" } }),
    );
    expect(result.current.scriptOutOfSync).toBe("0.9.0");
  });

  it("scriptOutOfSync clears once a later event reports a matching version again", async () => {
    const { result } = renderHook(() => useCoachChannel("call-version-recover"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 1, ts: "t1", scriptVersion: "0.9.0" } }),
    );
    expect(result.current.scriptOutOfSync).toBe("0.9.0");
    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 2, ts: "t2", scriptVersion: "1.0.1" } }),
    );
    expect(result.current.scriptOutOfSync).toBeNull();
  });

  it("scriptOutOfSync is left unchanged by an event that carries no scriptVersion at all", async () => {
    const { result } = renderHook(() => useCoachChannel("call-version-absent"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 1, ts: "t1", scriptVersion: "0.9.0" } }),
    );
    expect(result.current.scriptOutOfSync).toBe("0.9.0");
    act(() => latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 2, ts: "t2" } }));
    expect(result.current.scriptOutOfSync).toBe("0.9.0");
  });
});
