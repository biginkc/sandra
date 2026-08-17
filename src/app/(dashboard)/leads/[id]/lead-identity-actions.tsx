export function LeadIdentityActions({
  workingState,
  primaryActions,
  recordSignals,
  automationActions,
}: {
  workingState: React.ReactNode;
  primaryActions: React.ReactNode;
  recordSignals: React.ReactNode;
  automationActions: React.ReactNode;
}) {
  return (
    <section
      className="border-border bg-card rounded-xl border p-4 shadow-sm [&_button]:min-h-11 sm:[&_button]:min-h-8"
      aria-labelledby="lead-working-state-heading"
      data-testid="lead-identity-actions"
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0">
          <h2
            id="lead-working-state-heading"
            className="text-muted-foreground mb-2 text-[10px] font-black uppercase tracking-[0.14em]"
          >
            Working state
          </h2>
          <div
            className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center"
            data-testid="lead-working-state-controls"
          >
            {workingState}
          </div>
        </div>
        <div className="min-w-0 lg:text-right">
          <h2 className="text-muted-foreground mb-2 text-[10px] font-black uppercase tracking-[0.14em]">
            Primary actions
          </h2>
          <div
            className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end"
            data-testid="lead-primary-actions"
          >
            {primaryActions}
          </div>
        </div>
      </div>

      <div className="border-border mt-4 grid gap-4 border-t pt-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex flex-wrap items-center gap-2" data-testid="lead-record-signals">
          {recordSignals}
        </div>
        <div>
          <div className="text-muted-foreground mb-2 text-[10px] font-black uppercase tracking-[0.14em] lg:text-right">
            Automation &amp; enrichment
          </div>
          <div
            className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end"
            data-testid="lead-secondary-actions"
          >
            {automationActions}
          </div>
        </div>
      </div>
    </section>
  );
}
