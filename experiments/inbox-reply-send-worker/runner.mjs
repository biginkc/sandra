// Single-connection durable dispatch contract (Astra #4). Each exported unit
// is meant to be wrapped in its own ctx.run() by server.mjs's Restate handler
// so a crash/restart re-enters through claim() rather than replaying anything
// already journaled.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw Error('Invalid reply worker identity'); return value; }
const NOT_SENT = new Set(['not_sent_unauthorized', 'not_sent_stale_claim', 'not_sent_sender_busy', 'not_sent_window_expired', 'not_sent_frozen_mismatch']);
const STALE_CLAIM_CODES = new Set(['INBOX_REPLY_STALE_CLAIM', 'INBOX_REPLY_SENDER_BUSY', 'INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER', 'INBOX_REPLY_FROZEN_MISMATCH']);
function startDispatchMessageCode(error) {
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
    /** Step 1-6 of the architect brief. ONE pg.Client for claim -> authorize ->
     * start_dispatch (each already its own committed Postgres statement; the
     * shared connection keeps this attempt's whole pre-provider sequence off
     * the pool's OTHER connection budget, matching the two-connection cap).
     * The client is released BEFORE the provider call — never held across an
     * outbound HTTP request — and persist runs on a fresh pool connection,
     * since persist is independently fenced by dispatch_token and safe to
     * reconcile from any connection. NEVER calls transport() unless
     * start_dispatch returned an unambiguous {kind:'dispatch',...} AND that
     * call itself returned successfully (i.e. is known-committed) — a thrown
     * start_dispatch (STALE_CLAIM/SENDER_BUSY/WINDOW_EXPIRED/FROZEN_MISMATCH)
     * or any other error NEVER reaches the provider. */
    async dispatchAttempt(orgId, operationId, attemptId) {
      const o = id(orgId), op = id(operationId), a = id(attemptId);
      const client = await pool.connect();
      let released = false;
      const release = () => { if (!released) { released = true; client.release(); } };
      try {
        const claim = (await client.query('SELECT inbox_reply_send.worker_claim($1,$2) AS result', [o, a])).rows[0]?.result;
        if (!claim || typeof claim !== 'object') throw Error('Invalid claim result');
        if (claim.kind === 'busy') return { state: 'deferred' };
        if (claim.kind === 'existing') return { state: claim.state };
        if (claim.kind !== 'claimed' || typeof claim.generation !== 'string' || !/^[0-9]+$/.test(claim.generation)) throw Error('Invalid claim result');
        // [Astra #3] Requester re-auth, same connection, BEFORE the marker. A
        // raise here means: do NOT start_dispatch, do NOT send. Leave the
        // attempt claimed — its lease naturally expires and it is reclaimable
        // (or re-entered as 'existing' if another worker already progressed
        // it); this function returns without ever touching start_dispatch.
        try {
          await client.query('SELECT inbox_reply_send.worker_authorize($1,$2)', [o, op]);
        } catch {
          return { state: 'not_sent_unauthorized' };
        }
        let dispatch;
        try {
          dispatch = (await client.query('SELECT inbox_reply_send.worker_start_dispatch($1,$2,$3) AS result', [o, a, claim.generation])).rows[0]?.result;
        } catch (error) {
          // [Astra #4] never-provider-on-unknown-commit: ANY start_dispatch
          // failure (known business rejection or an ambiguous/unknown
          // outcome) means no token was ever returned to us, so there is
          // nothing safe to send. Re-entry goes back through claim() on the
          // next pass, which reads the row's actual committed state.
          const code = startDispatchMessageCode(error);
          return { state: code === 'INBOX_REPLY_SENDER_BUSY' ? 'not_sent_sender_busy' : code === 'INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER' ? 'not_sent_window_expired' : code === 'INBOX_REPLY_FROZEN_MISMATCH' ? 'not_sent_frozen_mismatch' : 'not_sent_stale_claim' };
        }
        if (!dispatch || typeof dispatch !== 'object') throw Error('Invalid start_dispatch result');
        if (dispatch.kind === 'skipped') return { state: 'skipped_ineligible', reason: dispatch.reason };
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
        return { state: receipt.state };
      } finally { release(); }
    },
  };
}
export function isNotSentState(state) { return NOT_SENT.has(state); }
