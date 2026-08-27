import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOSR_SCRIPT } from "./script-block";

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

/** Every wire event carries both content versions, always — required.
 * scriptVersion is deliberately the LOADED script's own version (not a
 * hardcoded literal) so tests that rely on it matching CLOSR_SCRIPT.version
 * (the "in sync" default case) don't silently start failing the next time
 * the script artifact's version bumps. */
const V = { scriptVersion: CLOSR_SCRIPT.version, matcherVersion: "3" };

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
    // Mirrors the real Supabase client: removeChannel() unsubscribes the
    // channel, which asynchronously fires that SAME channel's own
    // subscribe callback with CLOSED — this is real teardown behavior,
    // not a test artifact, and is exactly what makes the deliberate-
    // teardown/generation race (see the "invalidates generation" test
    // below) reachable. Deferred a microtask to model "asynchronous, not
    // synchronous" without needing exact real-world timing. Individual
    // tests override this per-call with mockImplementationOnce when they
    // need finer control (e.g. a removal that never resolves).
    removeChannel.mockReset().mockImplementation(async (channel: MockChannel) => {
      await Promise.resolve();
      channel._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CLOSED);
    });
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

    act(() => latestChannel()._broadcastHandler?.({ payload: { type: "phase", phaseId: "reveal", ts: "t1", ...V } }));
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

  it("does not start the liveness warning while ringing, then allows a full window once live without resubscribing", async () => {
    const { result, rerender } = renderHook(
      ({ live }) => useCoachChannel("call-ringing", "introduction", live),
      { initialProps: { live: false } },
    );
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(result.current.degraded).toBe(false);
    expect(channelSpy).toHaveBeenCalledTimes(1);

    rerender({ live: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(result.current.degraded).toBe(false);
    expect(channelSpy).toHaveBeenCalledTimes(1);

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
    act(() => latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 1, ts: "t1", ...V } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // 20s of wall-clock time passed, but the event at 10s reset the window,
    // so only 10s has elapsed since the last event — still not degraded.
    expect(result.current.degraded).toBe(false);
  });

  it("does NOT let malformed traffic re-arm liveness — a stream of garbage must surface as degraded, not keep the feed looking healthy", async () => {
    const { result } = renderHook(() => useCoachChannel("call-malformed-liveness"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // A malformed event lands at the 10s mark — under the old logic this
    // would have reset the 15s liveness window and cleared degraded,
    // exactly like a valid event. It must not.
    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "phase", phaseId: "not_a_real_phase", ts: "t1", ...V } }),
    );
    expect(result.current.malformedEventCount).toBe(1);
    expect(result.current.degraded).toBe(false); // not yet — only 10s since the last REAL liveness signal (subscribe)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    // 15.001s since SUBSCRIBED with nothing but malformed traffic in
    // between — the feed must show degraded, not healthy.
    expect(result.current.degraded).toBe(true);
  });

  it("does not clear degraded on a malformed event either", async () => {
    const { result } = renderHook(() => useCoachChannel("call-malformed-does-not-clear-degraded"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    expect(result.current.degraded).toBe(true);

    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "phase", phaseId: "not_a_real_phase", ts: "t1", ...V } }),
    );
    expect(result.current.degraded).toBe(true);
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

  it("awaits channel removal before creating its resubscribe replacement — never races removeChannel", async () => {
    // A removeChannel that resolves on our own schedule, not the mock's
    // default synchronous-ish behavior — proves the real code path
    // actually awaits it rather than only happening to work because a
    // test double resolved instantly.
    let releaseRemoval: (() => void) | null = null;
    removeChannel.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseRemoval = resolve; }),
    );

    renderHook(() => useCoachChannel("call-await-removal"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000); // past the first backoff delay
    });
    expect(removeChannel).toHaveBeenCalledTimes(1);
    const channelCountWhileRemovalPending = channels.length;
    // Give any stray microtasks a chance to run — the new channel must
    // still not exist while removal is deliberately held open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(channels.length).toBe(channelCountWhileRemovalPending);

    await act(async () => {
      releaseRemoval?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(channels.length).toBeGreaterThan(channelCountWhileRemovalPending);
  });

  it("invalidates generation before a deliberate teardown, so the old channel's own synthetic CLOSED (fired by removeChannel itself) can't schedule a second resubscribe that kills the replacement mid-join", async () => {
    // The mock's default removeChannel (see beforeEach) reproduces real
    // Supabase behavior: removing a channel asynchronously fires that
    // SAME channel's own subscribe callback with CLOSED. Without bumping
    // generation before calling it, that CLOSED would be indistinguishable
    // from a genuine new failure and would schedule a second, unwanted
    // resubscribe cycle.
    const { result } = renderHook(() => useCoachChannel("call-teardown-race"));
    await flush();
    const firstChannel = latestChannel();
    act(() => firstChannel._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));

    // Let the scheduled resubscribe fire: bump generation, remove the old
    // channel (synthesizing its own CLOSED in the process), create the
    // replacement.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(channels.length).toBe(2);
    const replacementChannel = latestChannel();
    expect(replacementChannel).not.toBe(firstChannel);

    // Advance well past every backoff tier. If the old channel's
    // synthetic CLOSED had been treated as live (the bug this guards), it
    // would have scheduled a phantom second resubscribe whose own backoff
    // fires somewhere in this window — tearing down the replacement
    // (removeChannel called again, a third channel created) while it may
    // still be mid-join.
    removeChannel.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(channels.length).toBe(2);
    expect(removeChannel).not.toHaveBeenCalled();

    // The replacement is still fully functional and its generation
    // tracking intact: its own SUBSCRIBED runs the normal code path
    // (marking reconnectGap, since the original CHANNEL_ERROR is still an
    // unresolved failed attempt) rather than being silently swallowed by
    // a mismatched/corrupted generation from the earlier race.
    act(() => replacementChannel._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.reconnectGap).toBe(true);
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

  it("resets transcript/degraded/reconnectGap/malformedEventCount/scriptOutOfSync when callId changes — a new call must never inherit the previous call's state", async () => {
    const { result, rerender } = renderHook(({ callId }) => useCoachChannel(callId), {
      initialProps: { callId: "call-A" },
    });
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({
        payload: { type: "transcript", speaker: "rep", text: "hello from call A", isFinal: true, ts: "t1", ...V },
      }),
    );
    expect(result.current.state.transcript).toHaveLength(1);

    // Force it degraded + gapped + malformed-counted + out-of-sync so
    // there's something real to prove got cleared, not just an untouched
    // default.
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "phase", phaseId: "not_a_real_phase", ts: "t2", ...V } }),
    );
    act(() =>
      latestChannel()._broadcastHandler?.({
        payload: { type: "counter", probeCount: 1, ts: "t3", ...V, scriptVersion: "0.9.0" },
      }),
    );
    expect(result.current.reconnectGap).toBe(true);
    expect(result.current.malformedEventCount).toBe(1);
    expect(result.current.scriptOutOfSync).toBe("0.9.0");

    rerender({ callId: "call-B" });
    await flush();

    expect(result.current.state.transcript).toEqual([]);
    expect(result.current.state.currentPhaseId).toBe("introduction");
    expect(result.current.degraded).toBe(false);
    expect(result.current.reconnectGap).toBe(false);
    expect(result.current.malformedEventCount).toBe(0);
    expect(result.current.scriptOutOfSync).toBeNull();
    // The new callId subscribes on a fresh channel — coach:call-B, not a
    // reused coach:call-A instance.
    expect(channelSpy).toHaveBeenCalledWith("coach:call-B", { config: { private: true } });
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

  it("marks reconnectGap on a real reconnect (a SUBSCRIBED after an error), not on a clean first subscribe", async () => {
    const { result } = renderHook(() => useCoachChannel("call-gap"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.reconnectGap).toBe(false);

    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.reconnectGap).toBe(true);
  });

  it("marks reconnectGap even on the VERY FIRST join, when that join only succeeded after an initial failure — the coach_call_index write race", async () => {
    // Regression: the ownership row the RLS policy checks is written via
    // after() (jitter-server.ts) and isn't guaranteed to exist yet when
    // the browser's first subscribe attempt fires. That first attempt can
    // legitimately CHANNEL_ERROR, then succeed on retry — and events may
    // have been emitted by the producer in between. The old logic only
    // flagged a gap on a SUBSCRIBED that followed an EARLIER SUBSCRIBED,
    // so a first-join failure that later succeeded reported as a clean,
    // healthy connection — hiding a real gap.
    const { result } = renderHook(() => useCoachChannel("call-first-join-failure"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.reconnectGap).toBe(true);
  });

  it("does NOT clear reconnectGap on a fresh valid event — it represents unrecoverable missed history, not a transient blip", async () => {
    const { result } = renderHook(() => useCoachChannel("call-gap-clear"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(result.current.reconnectGap).toBe(true);

    act(() => latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 2, ts: "t1", ...V } }));
    expect(result.current.reconnectGap).toBe(true);

    // Only the explicit rep acknowledgment clears it.
    act(() => result.current.dismissReconnectGap());
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
      latestChannel()._broadcastHandler?.({ payload: { type: "phase", phaseId: "not_a_real_phase", ts: "t1", ...V } }),
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
        payload: {
          type: "coach_note",
          text: "Never open with 'How are you doing today?'",
          phaseId: "introduction",
          ts: "t1",
          ...V,
        },
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
      latestChannel()._broadcastHandler?.({
        payload: { type: "counter", probeCount: 1, ts: "t1", ...V },
      }),
    );
    expect(result.current.scriptOutOfSync).toBeNull();
  });

  it("scriptOutOfSync flags the remote version the moment an event reports a mismatch", async () => {
    const { result } = renderHook(() => useCoachChannel("call-version-mismatch"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({
        payload: { type: "counter", probeCount: 1, ts: "t1", ...V, scriptVersion: "0.9.0" },
      }),
    );
    expect(result.current.scriptOutOfSync).toBe("0.9.0");
  });

  it("scriptOutOfSync clears once a later event reports a matching version again", async () => {
    const { result } = renderHook(() => useCoachChannel("call-version-recover"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({
        payload: { type: "counter", probeCount: 1, ts: "t1", ...V, scriptVersion: "0.9.0" },
      }),
    );
    expect(result.current.scriptOutOfSync).toBe("0.9.0");
    act(() =>
      latestChannel()._broadcastHandler?.({ payload: { type: "counter", probeCount: 2, ts: "t2", ...V } }),
    );
    expect(result.current.scriptOutOfSync).toBeNull();
  });

  it("an event missing scriptVersion is dropped as malformed and leaves scriptOutOfSync unchanged", async () => {
    const { result } = renderHook(() => useCoachChannel("call-version-absent"));
    await flush();
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    act(() =>
      latestChannel()._broadcastHandler?.({
        payload: { type: "counter", probeCount: 1, ts: "t1", ...V, scriptVersion: "0.9.0" },
      }),
    );
    expect(result.current.scriptOutOfSync).toBe("0.9.0");

    // Missing scriptVersion entirely — per the wire contract this is a
    // malformed event, not a legacy unversioned one. It's dropped whole,
    // so scriptOutOfSync (and everything else) is left exactly as it was.
    act(() =>
      latestChannel()._broadcastHandler?.({
        payload: { type: "counter", probeCount: 2, ts: "t2", matcherVersion: V.matcherVersion },
      }),
    );
    expect(result.current.scriptOutOfSync).toBe("0.9.0");
    expect(result.current.malformedEventCount).toBe(1);
  });
});
