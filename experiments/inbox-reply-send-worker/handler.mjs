export function createRunHandler({ runner, pool }) {
  return async (ctx, input) => {
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 2) {
      throw Error('Invalid reply dispatch request');
    }

    const orgId = String(input.orgId);
    const operationId = String(input.operationId);
    const attemptIds = await ctx.run('list-attempts', () => runner.operationAttempts(orgId, operationId));
    const results = [];

    for (const attemptId of attemptIds) {
      // A provider receipt is journaled separately from its ledger write. A
      // replay therefore has the receipt available without calling transport
      // again, while a rolled-back persist can safely retry the wrapper.
      const dispatch = await ctx.run(`dispatch:${attemptId}`, async () => {
        const result = await runner.dispatchAttempt(orgId, operationId, attemptId);
        if (result.kind !== 'settled' && result.kind !== 'dispatched') {
          throw Error(`reply attempt ${attemptId} not yet settled: ${result.kind}${result.reason ? `(${result.reason})` : ''}`);
        }
        return result;
      });
      const outcome = dispatch.kind === 'settled'
        ? dispatch
        : await ctx.run(`persist:${attemptId}`, async () => runner.persistAttempt(orgId, operationId, attemptId, dispatch));
      results.push(outcome);
    }

    const acknowledged = await ctx.run('ack-if-complete', async () => {
      return (await pool.query('SELECT inbox_reply_send.operation_dispatch_complete($1,$2) AS ready', [orgId, operationId])).rows[0]?.ready === true;
    });
    return { operationId, attempts: results, complete: acknowledged };
  };
}
