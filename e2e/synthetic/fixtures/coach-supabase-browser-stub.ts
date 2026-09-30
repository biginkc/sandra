type BroadcastCallback = (message: { payload: unknown }) => void;
type StatusCallback = (status: string) => void;

const broadcastCallbacks = new Map<BroadcastCallback, string>();
const statusCallbacks = new Set<StatusCallback>();

export function hasSyntheticCoachSubscriber(): boolean {
  return broadcastCallbacks.size > 0;
}

export function emitSyntheticCoachStatus(status: string): void {
  for (const callback of statusCallbacks) callback(status);
}

export function emitSyntheticCoachBroadcast(payload: unknown, topic?: string): void {
  for (const [callback, subscribedTopic] of broadcastCallbacks) {
    if (topic === undefined || topic === subscribedTopic) callback({ payload });
  }
}

export function createClient() {
  return {
    auth: { getSession: async () => ({ data: { session: null } }) },
    realtime: { setAuth: () => undefined },
    channel: (topic: string) => {
      let broadcastCallback: BroadcastCallback | null = null;
      let statusCallback: StatusCallback | null = null;
      const channel = {
        on: (_kind: string, _filter: unknown, callback: BroadcastCallback) => {
          broadcastCallback = callback;
          broadcastCallbacks.set(callback, topic);
          return channel;
        },
        subscribe: (callback: StatusCallback) => {
          statusCallback = callback;
          statusCallbacks.add(callback);
          queueMicrotask(() => callback("SUBSCRIBED"));
          return channel;
        },
        __dispose: () => {
          if (broadcastCallback) broadcastCallbacks.delete(broadcastCallback);
          if (statusCallback) statusCallbacks.delete(statusCallback);
        },
      };
      return channel;
    },
    removeChannel: async (channel: { __dispose?: () => void }) => {
      channel.__dispose?.();
      return "ok";
    },
  };
}
