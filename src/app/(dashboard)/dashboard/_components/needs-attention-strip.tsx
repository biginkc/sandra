import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { DashboardSummary } from "../queries";

type Props = { needs: DashboardSummary["needs_attention"] };

type Row = {
  count: number;
  label: string;
  href: string;
  dotClass: string;
};

export function NeedsAttentionStrip({ needs }: Props) {
  const rows: Row[] = [
    {
      count: needs.escalated_unhandled,
      label: "Escalated, needs reply (>1hr)",
      href: "/messages?filter=escalated",
      dotClass: "bg-red-500",
    },
    {
      count: needs.stale_conversations,
      label: "Stale conversations (no reply >7d)",
      href: "/leads?stale=true",
      dotClass: "bg-yellow-500",
    },
    {
      count: needs.sequence_ended_no_followup,
      label: "Sequences ended without follow-up",
      href: "/leads?sequence_ended=true",
      dotClass: "bg-yellow-500",
    },
    {
      count: needs.unassigned,
      label: "Unassigned leads",
      href: "/leads?unassigned=true",
      dotClass: "bg-stone-400",
    },
  ];

  const visible = rows.filter((r) => r.count > 0);

  if (visible.length === 0) {
    return (
      <div className="border-border bg-card flex items-center gap-3 rounded-2xl border px-6 py-4">
        <span className="size-3 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        <span className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
          Needs Attention
        </span>
        <span className="text-foreground text-sm font-bold">All clear ✓</span>
      </div>
    );
  }

  return (
    <div className="border-border bg-card rounded-2xl border px-6 py-4">
      <div className="text-muted-foreground mb-3 text-[11px] font-bold tracking-widest uppercase">
        Needs Attention
      </div>
      <ul className="divide-border divide-y">
        {visible.map((row) => (
          <li key={row.href}>
            <Link
              href={row.href}
              className="hover:bg-muted/60 -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 transition-colors"
            >
              <span className={`size-2.5 shrink-0 rounded-full ${row.dotClass}`} aria-hidden />
              <span className="text-foreground text-base font-bold tabular-nums">
                {row.count}
              </span>
              <span className="text-foreground text-sm font-medium">{row.label}</span>
              <ChevronRight className="text-muted-foreground ml-auto size-4" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
