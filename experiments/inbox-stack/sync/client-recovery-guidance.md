# Installed Electric client1.5.28 recovery contract

Read-only source inspection: `node_modules/@electric-sql/client/src/{client,fetch,error}.ts`. This note is guidance, not tested browser implementation.

- `FetchError` is exported by the package; fields include status, json, text, headers and URL. Use `error instanceof FetchError` and `error.status`; gateway reason is its JSON `{error: string}`. Do not display/log raw error.message because it includes request URL and response details.
- Network, 5xx and429 are automatically retried **before** onError. Defaults: initial1000ms, maximum32000ms, multiplier2, infinite retries. Configure finite attempts if the application must notice expiry and persistent outages.
- Returning undefined stops the stream. Returning `{}` retries the same URL/offset. RetryOpts changes headers/params only and retains continuation state; it cannot replace an expired shape URL. Callback-driven retries apply full jitter and a50-consecutive-retry guard.

Suggested bounded browser policy:

```ts
backoffOptions: {
  initialDelay: 500, maxDelay: 5000, multiplier: 2, maxRetries: 3,
  onFailedAttempt: () => markCurrentGenerationStale(),
},
onError: (error) => {
  if (!isCurrentGeneration(generation)) return;
  const status = error instanceof FetchError ? error.status : undefined;
  if (status === 401 || status === 403) {
    scheduleOnceOutsideCallback(() => disposeAndClearUnauthorizedGeneration(generation));
    return;
  }
  if (status === 410 || Date.now() >= expiresAt) {
    scheduleOnceOutsideCallback(() => renewWorksetWithFreshAuth(generation));
    return;
  }
  if (status === 429 || (status !== undefined && status >= 500) || status === undefined) {
    markCurrentGenerationStale();
    // App also owns an AbortController + deadline timer, so this cannot retry forever beyond TTL.
    return {};
  }
  showNonRetryableSyncProblem(); // 400,404,414 etc are not generic network failures.
  return;
}
```

On401/403, clear rendered data, DB collection, detail/query cache and selection for the denied scope; do not blindly refresh access or loop. Production401 session refresh can be designed separately, but fixture constants offer no refresh semantics. An epoch_changed403 is denial, not proof that old rights remain valid.

On410, perform a single-flight renewal in the application coordinator: stop old stream, POST a new server-authorized workset, create a new collection/new AbortController/new URL, wait for readiness, and swap. Selected IDs may survive expiry but require renewed eligibility; no send during uncertain authorization. Delete old generation to avoid the gateway's two-generation cap. Avoid awaiting collection cleanup inside its own onError callback; schedule the coordinator outside the callback and guard against stale completions.

For the60s fixture TTL, renew around45s or enforce an explicit deadline timer that aborts retries at expiry. Hidden-tab timer delays do not extend server authority; visibility resume compares Date.now with expiresAt and renews. A late error from an old generation must not clear its replacement. If disconnected renewal fails, preserve only previously allowed readable content with stale labeling until authority is denied/expired per chosen policy; never carry it across a tenant/user switch.

The current gateway aborts idle upstream requests at5s and reports503. This produces periodic transient failures even during ordinary idle operation; the browser should retry with backoff and show stale/reconnecting as appropriate. A production gateway should return a correct bounded long-poll response/lease contract instead of relying on503 as a normal heartbeat. This fixture limitation is not proof of healthy production transport.
