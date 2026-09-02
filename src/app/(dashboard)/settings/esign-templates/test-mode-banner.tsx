export function EsignModeBanner({ testMode = true }: { testMode?: boolean }) {
  return (
    <div className={`${testMode ? "border-alert-warning/40 bg-alert-warning/10" : "border-destructive/30 bg-destructive/5"} text-foreground flex flex-col gap-1 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between`}>
      <span className="flex items-center gap-3">
        <span className={`${testMode ? "border-alert-warning/60 bg-alert-warning/15 text-alert-warning" : "border-destructive/40 bg-destructive/10 text-destructive"} inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[10px] font-bold tracking-[0.1em]`}>
          {testMode ? "TEST MODE" : "LIVE MODE"}
        </span>
        <span>
          {testMode
            ? "Dropbox Sign is in test mode. Documents are watermarked and are not legally binding."
            : "Dropbox Sign is in live mode. New sends are legally binding and count against Dropbox Sign billing."}
        </span>
      </span>
      <a
        href="/settings/integrations"
        className="font-medium underline underline-offset-4"
      >
        Integration settings
      </a>
    </div>
  );
}

export function TestModeBanner() {
  return <EsignModeBanner testMode />;
}
