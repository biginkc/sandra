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
      className="border-border bg-card border-b px-4 py-2.5 md:px-6 [&_button]:min-h-9 sm:[&_button]:min-h-8"
      aria-labelledby="lead-working-state-heading"
      data-testid="lead-working-state-bar"
    >
      <h2 id="lead-working-state-heading" className="sr-only">
        Working state
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex min-w-0 flex-wrap items-center gap-2"
          data-testid="lead-working-state-controls"
        >
          {workingState}
        </div>
        {nextAction ? <div className="min-w-0">{nextAction}</div> : null}
        <div
          className="flex min-w-0 flex-wrap items-center gap-2 min-[1180px]:ml-auto min-[1180px]:justify-end"
          data-testid="lead-record-signals"
        >
          {recordSignals}
        </div>
      </div>
    </section>
  );
}
