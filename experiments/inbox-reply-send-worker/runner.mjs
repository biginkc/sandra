// Single-connection durable dispatch contract (Astra #4). dispatchAttempt's
// result is a discriminated {kind} exactly mirroring src/lib/inbox/
// reply-dispatch.ts's ReplyAttemptResult:
//  - {kind:'settled', state} — a real ledger state was written or read back.
//    Safe (and REQUIRED) to memoize durably: a replay must return this same
//    value without re-calling the provider.
//  - {kind:'deferred'} — nothing happened (claim saw a live lease held by
//    someone else, OR the ledger's own marker fencing rejected this pass
//    because of a live sender-busy/generation race). NEVER durable, NEVER a
//    reason to journal anything — must be retried.
//  - {kind:'not_sent', reason} — the requester's re-authorization failed
//    (fused into worker_start_dispatch, Astra B1), or start_dispatch raised
//    for a reason other than sender-busy (stale claim / window expired /
//    frozen mismatch). Also NEVER durable — retried, same as deferred.
// [Astra B2] server.mjs is responsible for NEVER letting a non-'settled'
// result be memoized by Restate's ctx.run — see its own comments.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw Error('Invalid reply worker identity'); return value; }
const SETTLED = new Set(['skipped_ineligible', 'provider_accepted', 'uncertain', 'confirmed_not_submitted', 'rejected_unsent', 'delivered', 'delivery_failed']);
function settled(state) { if (!SETTLED.has(state)) throw Error(`Unmapped reply attempt state: ${state}`); return { kind: 'settled', state }; }
const STALE_CLAIM_CODES = ['INBOX_REPLY_STALE_CLAIM', 'INBOX_REPLY_SENDER_BUSY', 'INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER', 'INBOX_REPLY_FROZEN_MISMATCH', 'INBOX_REPLY_REQUESTER_UNAUTHORIZED', 'INBOX_REPLY_ATTEMPT_UNAVAILABLE', 'INBOX_REPLY_OPERATION_UNAVAILABLE', 'INBOX_ACCESS_BASELINE_MISSING'];
function startDispatchFailureCode(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  for (const code of STALE_CLAIM_CODES) if (message.includes(code)) return code;
  return null;
}
export function createRunner(pool, transport) {
  return {
    /** Ordered attempt ids the operation still needs driven through dispatch. */
    async operationAttempts(orgId, operationId) {
      const rows = (await pool.query('SELECT * FROM inbox_reply_send.operation_attempts($1,$2)', [id(orgId), id(operationId)])).rows;
      return rows.map(r => id(r.operation_attempts));
    },
    /** ONE pg.Client for claim -> worker_start_dispatch (which, since Astra
     * B1, folds the requester re-authorization check and the ledger marker
     * into ONE statement/transaction — the access-epoch FOR SHARE lock taken
     * inside worker_start_dispatch is held through the marker write, so a
     * concurrent revocation cannot land in the gap). The client is released
     * BEFORE the provider call — never held across an outbound HTTP request —
     * and persist runs on a fresh pool connection, since persist is
     * independently fenced by dispatch_token and safe to reconcile from any
     * connection. NEVER calls transport() unless worker_start_dispatch
     * returned an unambiguous {kind:'dispatch',...} AND that call itself
     * returned successfully (i.e. is known-committed) — any thrown
     * worker_start_dispatch error (STALE_CLAIM/SENDER_BUSY/WINDOW_EXPIRED/
     * FROZEN_MISMATCH/REQUESTER_UNAUTHORIZED/unknown) NEVER reaches the
     * provider. */
    async dispatchAttempt(orgId, operationId, attemptId) {
      const o = id(orgId), op = id(operationId), a = id(attemptId);
      const client = await pool.connect();
      let released = false;
      const release = () => { if (!released) { released = true; client.release(); } };
      try {
        const claim = (await client.query('SELECT inbox_reply_send.worker_claim($1,$2) AS result', [o, a])).rows[0]?.result;
        if (!claim || typeof claim !== 'object') throw Error('Invalid claim result');
        if (claim.kind === 'busy') return { kind: 'deferred' };
        if (claim.kind === 'existing') return settled(claim.state);
        if (claim.kind !== 'claimed' || typeof claim.generation !== 'string' || !/^[0-9]+$/.test(claim.generation)) throw Error('Invalid claim result');
        let dispatch;
        try {
          dispatch = (await client.query('SELECT inbox_reply_send.worker_start_dispatch($1,$2,$3) AS result', [o, a, claim.generation])).rows[0]?.result;
        } catch (error) {
          // [Astra #4] never-provider-on-unknown-commit + [Astra B2] sender-
          // busy is a DEFERRED (retryable), not a distinctly-reasoned
          // not_sent — it is the exact same "someone else is mid-flight,
          // try again" shape as a busy claim, and must never be memoized as
          // if it were final either. Every other start_dispatch failure
          // (including the fused Astra B1 requester-unauthorized check) is
          // not_sent: still never durable, still always retried by the
          // caller (server.mjs), but reported with a reason for
          // observability.
          const code = startDispatchFailureCode(error);
          if (code === 'INBOX_REPLY_SENDER_BUSY') return { kind: 'deferred' };
          return { kind: 'not_sent', reason: code ?? 'start_dispatch_failed' };
        }
        if (!dispatch || typeof dispatch !== 'object') throw Error('Invalid start_dispatch result');
        if (dispatch.kind === 'skipped') return settled('skipped_ineligible');
        if (dispatch.kind !== 'dispatch' || typeof dispatch.token !== 'string' || typeof dispatch.to !== 'string' || typeof dispatch.from !== 'string' || typeof dispatch.body !== 'string') throw Error('Invalid start_dispatch result');
        const { token, from, to, body } = dispatch;
        release(); // Every lock released BEFORE the outbound provider call.
        let result;
        try { result = await transport({ from, to, body }, AbortSignal.timeout(15_000)); }
        catch { result = { kind: 'uncertain', reason: 'transport_or_timeout' }; }
        const providerResult = result.kind === 'accepted' ? { kind: 'accepted', externalId: result.externalId, status: result.providerStatus }
          : result.kind === 'not_attempted' ? { kind: 'not_attempted', reason: result.reason }
          : { kind: 'uncertain', reason: result.reason ?? 'unknown' };
        const receipt = (await pool.query('SELECT inbox_reply_send.worker_persist($1,$2,$3,$4::jsonb) AS result', [o, a, token, JSON.stringify(providerResult)])).rows[0]?.result;
        if (!receipt || typeof receipt.state !== 'string') throw Error('Invalid persist result');
        return settled(receipt.state);
      } finally { release(); }
    },
  };
}
