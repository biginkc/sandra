export const inboxReplySendServiceOptions = Object.freeze({
  retryPolicy: Object.freeze({
    initialInterval: 500,
    exponentiationFactor: 2,
    maxInterval: 60_000,
    maxAttempts: 70,
    onMaxAttempts: 'pause',
  }),
  inactivityTimeout: 3 * 60_000,
  abortTimeout: 10 * 60_000,
});

export function createInboxReplySendService(restate, runHandler) {
  return restate.service({
    name: 'InboxReplySend',
    options: inboxReplySendServiceOptions,
    handlers: { run: runHandler },
  });
}
