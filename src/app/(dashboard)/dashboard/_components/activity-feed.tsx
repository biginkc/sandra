import {
  AlertTriangle,
  CheckCircle2,
  Download,
  MessageSquare,
  Search,
} from "lucide-react";
import Link from "next/link";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";

import type { ActivityRow } from "../queries";

import { RelativeTime } from "./relative-time";

type Props = { events: ActivityRow[] };

export function ActivityFeed({ events }: Props) {
  if (events.length === 0) {
    return (
      <div className="border-border bg-card rounded-2xl border px-5 py-5">
        <h2 className="text-foreground text-base font-bold">Recent activity</h2>
        <p className="text-muted-foreground mt-3 text-sm">
          No recent activity in the last 7 days.
        </p>
      </div>
    );
  }

  return (
    <div className="border-border bg-card rounded-2xl border px-5 py-5">
      <h2 className="text-foreground mb-4 text-base font-bold">Recent activity</h2>
      <ul className="space-y-3">
        {events.map((e, i) => (
          <li key={`${e.kind}-${e.at}-${i}`}>
            <ActivityRowView event={e} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActivityRowView({ event }: { event: ActivityRow }) {
  const meta = formatEvent(event);
  const Icon = meta.icon;
  const inner = (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          meta.iconBg,
        )}
        aria-hidden
      >
        <Icon className={cn("size-4", meta.iconColor)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm font-medium leading-snug">
          {meta.summary}
        </div>
        <RelativeTime iso={event.at} className="text-xs" />
      </div>
    </div>
  );

  if (meta.href) {
    return (
      <Link
        href={meta.href}
        className="-mx-2 block rounded-lg px-2 py-1.5 hover:bg-stone-50"
      >
        {inner}
      </Link>
    );
  }

  return <div className="-mx-2 px-2 py-1.5">{inner}</div>;
}

type EventMeta = {
  icon: ComponentType<{ className?: string }>;
  iconBg: string;
  iconColor: string;
  summary: string;
  href?: string;
};

function formatEvent(event: ActivityRow): EventMeta {
  switch (event.kind) {
    case "inbound_message":
      return {
        icon: MessageSquare,
        iconBg: "bg-stone-100",
        iconColor: "text-stone-700",
        summary: `New reply${event.address ? ` — ${formatLocation(event)}` : ""}: "${truncate(event.preview, 60)}"`,
        href: event.property_id ? `/leads/${event.property_id}` : undefined,
      };
    case "sequence_completed":
      return {
        icon: CheckCircle2,
        iconBg: "bg-emerald-50",
        iconColor: "text-emerald-700",
        summary: `Sequence completed — "${event.sequence_name}"`,
        href: event.property_id ? `/leads/${event.property_id}` : undefined,
      };
    case "import_done":
      return {
        icon: Download,
        iconBg: "bg-stone-100",
        iconColor: "text-stone-700",
        summary: "Import job finished",
        href: "/jobs",
      };
    case "skip_trace_done":
      return {
        icon: Search,
        iconBg: "bg-stone-100",
        iconColor: "text-stone-700",
        summary: "Skip-trace job finished",
        href: "/jobs",
      };
    case "ai_escalation":
      return {
        icon: AlertTriangle,
        iconBg: "bg-amber-50",
        iconColor: "text-amber-700",
        summary: `AI escalation${event.address ? ` — ${formatLocation(event)}` : ""}${event.reason ? `: ${truncate(event.reason, 60)}` : ""}`,
        href: event.property_id ? `/leads/${event.property_id}` : undefined,
      };
  }
}

function formatLocation(e: { city: string | null; state: string | null }): string {
  return [e.city, e.state].filter(Boolean).join(", ") || "";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
