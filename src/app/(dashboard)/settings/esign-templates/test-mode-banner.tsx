export function TestModeBanner() {
  return (
    <div className="border-alert-warning/40 bg-alert-warning/10 text-foreground flex flex-col gap-1 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="flex items-center gap-3">
        <span className="border-alert-warning/60 bg-alert-warning/15 text-alert-warning inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[10px] font-bold tracking-[0.1em]">
          TEST MODE
        </span>
        <span>
          Dropbox Sign is in test mode. Documents are watermarked and are not
          legally binding.
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
