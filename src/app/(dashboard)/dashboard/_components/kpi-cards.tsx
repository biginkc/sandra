import Link from "next/link";

import type { AssignedRow, DashboardSummary } from "../queries";

import { Donut } from "./donut";

type Props = { summary: DashboardSummary; currentUserId: string };

export function KpiRowOne({
  totalLeads,
  newThisWeek,
  notInDrip,
  assigned,
  currentUserId,
}: {
  totalLeads: number;
  newThisWeek: number;
  notInDrip: number;
  assigned: AssignedRow[];
  currentUserId: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
      <Link
        href="/leads"
        className="border-border bg-card hover:border-foreground/30 group rounded-2xl border px-6 py-5 transition-colors"
      >
        <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
          Total leads
        </div>
        <div className="text-foreground mt-2 text-4xl font-extrabold tracking-tight tabular-nums">
          {totalLeads.toLocaleString()}
        </div>
        {newThisWeek > 0 && (
          <div className="mt-2 inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-100 ring-inset">
            +{newThisWeek.toLocaleString()} this week
          </div>
        )}
      </Link>

      <AssignedCard assigned={assigned} currentUserId={currentUserId} />

      <Link
        href="/leads?no_active_sequence=true"
        className="border-border bg-card hover:border-foreground/30 group rounded-2xl border px-6 py-5 transition-colors"
      >
        <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
          Not in a drip campaign
        </div>
        <div className="text-foreground mt-2 text-4xl font-extrabold tracking-tight tabular-nums">
          {notInDrip.toLocaleString()}
        </div>
        <div className="text-muted-foreground mt-2 text-xs font-bold group-hover:text-foreground">
          Click to enroll →
        </div>
      </Link>
    </div>
  );
}

function AssignedCard({
  assigned,
  currentUserId,
}: {
  assigned: AssignedRow[];
  currentUserId: string;
}) {
  const me = assigned.find((a) => a.user_id === currentUserId);
  const others = assigned.filter((a) => a.user_id !== currentUserId);

  return (
    <div className="border-border bg-card rounded-2xl border px-6 py-5">
      <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
        Assigned
      </div>
      <ul className="divide-border mt-3 divide-y">
        <AssignedLine
          label="Assigned to me"
          count={me?.count ?? 0}
          href={`/leads?assignee=me`}
        />
        {others.length === 0 && !me && (
          <AssignedLine label="No assignments" count={0} href="/leads" />
        )}
        {others.map((row) => (
          <AssignedLine
            key={row.user_id}
            label={`Assigned to ${displayName(row.email)}`}
            count={row.count}
            href={`/leads?assignee=${row.user_id}`}
          />
        ))}
      </ul>
    </div>
  );
}

function AssignedLine({
  label,
  count,
  href,
}: {
  label: string;
  count: number;
  href: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="hover:bg-muted/60 -mx-2 flex items-center justify-between rounded-lg px-2 py-2 transition-colors"
      >
        <span className="text-foreground text-sm font-medium">{label}</span>
        <span className="text-foreground text-xl font-extrabold tabular-nums">
          {count.toLocaleString()}
        </span>
      </Link>
    </li>
  );
}

function displayName(email: string | null): string {
  if (!email) return "teammate";
  const local = email.split("@")[0];
  if (!local) return email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function KpiRowTwo({ summary }: Props) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <Link
        href="/leads?status=hot"
        className="border-border bg-card hover:border-foreground/30 group rounded-2xl border px-6 py-5 transition-colors"
      >
        <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
          Hot leads
        </div>
        <div className="mt-4 flex items-center justify-center">
          <Donut
            numerator={summary.hot_leads.numerator}
            denominator={summary.hot_leads.denominator}
          />
        </div>
        <div className="text-muted-foreground mt-3 text-center text-xs font-medium">
          Interested + offers sent
        </div>
      </Link>

      <Link
        href="/leads?skip_traced=false"
        className="border-border bg-card hover:border-foreground/30 group rounded-2xl border px-6 py-5 transition-colors"
      >
        <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
          Skip-trace coverage
        </div>
        <div className="mt-4 flex items-center justify-center">
          <Donut
            numerator={summary.skip_trace_coverage.numerator}
            denominator={summary.skip_trace_coverage.denominator}
          />
        </div>
        <div className="text-muted-foreground mt-3 text-center text-xs font-medium">
          Phone numbers gathered
        </div>
      </Link>
    </div>
  );
}
