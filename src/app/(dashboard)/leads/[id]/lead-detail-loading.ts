/**
 * Keep independent lead-detail reads in flight while preserving the one
 * ordering boundary that matters for the activity thread: the read
 * acknowledgement must settle before its message snapshot starts.
 *
 * Promise.resolve observes a lazy thenable immediately. This matters for
 * Supabase query builders, which do not start their request until they are
 * assimilated by an await or Promise combinator.
 */
export async function loadAfterReadAcknowledgement<
  TIndependent,
  TAcknowledgement,
  TSnapshot,
>(
  independentReads: PromiseLike<TIndependent>,
  acknowledge: () => PromiseLike<TAcknowledgement>,
  readSnapshot: () => PromiseLike<TSnapshot>,
): Promise<{
  independent: TIndependent;
  acknowledgement: TAcknowledgement;
  snapshot: TSnapshot;
}> {
  const independentPromise = Promise.resolve(independentReads);
  // Attach both branches before waiting on the acknowledgement. If an
  // independent query rejects while the acknowledgement is slow, this keeps
  // that rejection observed instead of briefly becoming an unhandled one.
  const independentSettled = independentPromise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  const acknowledgement = await acknowledge();
  const snapshot = await readSnapshot();
  const settled = await independentSettled;
  if (!settled.ok) throw settled.error;
  return { independent: settled.value, acknowledgement, snapshot };
}
