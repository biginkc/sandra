export function LeadIdentityActions({
  workingState,
  recordSignals,
  nextAction,
}: {
  workingState: React.ReactNode;
  recordSignals: React.ReactNode;
  nextAction?: React.ReactNode;
}) {
  return (
    <section
      className="order-2 border-border bg-card border-y px-4 py-3 shadow-sm md:px-6 [&_button]:min-h-9"
      aria-labelledby="lead-working-state-heading"
      data-testid="lead-working-state-bar"
    >
      <h2 id="lead-working-state-heading" className="sr-only">
        Working state
      </h2>
      <div className="flex flex-col gap-3 min-[1180px]:flex-row min-[1180px]:items-center">
        <div
          className="flex min-w-0 flex-wrap items-center gap-2"
          data-testid="lead-working-state-controls"
        >
          {workingState}
        </div>
        {nextAction ? <div className="min-w-0 flex-1">{nextAction}</div> : null}
        <div
          className="flex flex-wrap items-center gap-2 min-[1180px]:justify-end"
          data-testid="lead-record-signals"
        >
          {recordSignals}
        </div>
      </div>
    </section>
  );
}
