type BroadcastCallback = (message: { payload: unknown }) => void;
type StatusCallback = (status: string) => void;

const broadcastCallbacks = new Set<BroadcastCallback>();
const statusCallbacks = new Set<StatusCallback>();

export function emitSyntheticCoachStatus(status: string): void {
  for (const callback of statusCallbacks) callback(status);
}

export function emitSyntheticCoachBroadcast(payload: unknown): void {
  for (const callback of broadcastCallbacks) callback({ payload });
}

export function createClient() {
  return {
    auth: { getSession: async () => ({ data: { session: null } }) },
    realtime: { setAuth: () => undefined },
    channel: () => {
      let broadcastCallback: BroadcastCallback | null = null;
      let statusCallback: StatusCallback | null = null;
      const channel = {
        on: (_kind: string, _filter: unknown, callback: BroadcastCallback) => {
          broadcastCallback = callback;
          broadcastCallbacks.add(callback);
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
