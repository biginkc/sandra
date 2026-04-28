import Link from "next/link";

import type { SkipTraceBalance } from "@/lib/skip-trace/balance";

type Props = { balance: SkipTraceBalance };

export function SkipTraceCredits({ balance }: Props) {
  if (!balance.available) {
    return (
      <div className="border-border bg-card flex items-center justify-between rounded-2xl border px-6 py-5">
        <div>
          <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
            Skip-trace credits
          </div>
          <div className="text-foreground mt-1 text-base font-medium">
            {balance.reason === "unconfigured"
              ? "Provider not configured"
              : "Balance unavailable — check settings"}
          </div>
        </div>
        <Link
          href="/admin/skip-trace-settings"
          className="text-foreground text-sm font-bold underline-offset-4 hover:underline"
        >
          Open settings →
        </Link>
      </div>
    );
  }

  const dotColor =
    balance.tier === "ok"
      ? "bg-emerald-500"
      : balance.tier === "low"
        ? "bg-amber-500"
        : "bg-red-500";

  const tierLabel =
    balance.tier === "ok" ? "Healthy" : balance.tier === "low" ? "Low" : "Critical";

  return (
    <div className="border-border bg-card flex items-center justify-between gap-6 rounded-2xl border px-6 py-5">
      <div className="flex items-center gap-4">
        <span className={`size-3 shrink-0 rounded-full ${dotColor}`} aria-hidden />
        <div>
          <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
            Skip-trace credits
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-foreground text-4xl font-extrabold tracking-tight">
              {balance.credits.toLocaleString()}
            </span>
            <span className="text-muted-foreground text-sm font-medium">
              credits remaining · {tierLabel}
            </span>
          </div>
        </div>
      </div>
      <Link
        href="/admin/skip-trace-settings"
        className="bg-foreground text-background rounded-full px-5 py-2.5 text-sm font-bold transition-opacity hover:opacity-90"
      >
        Top up →
      </Link>
    </div>
  );
}
