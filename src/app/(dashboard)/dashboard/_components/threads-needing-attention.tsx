import Link from "next/link";

import type { ThreadRow } from "../queries";
import { humanizeMachineValue } from "@/lib/presentation/system-labels";

import { isOlderThan, RelativeTime } from "./relative-time";

type Props = { threads: ThreadRow[]; totalCount: number; nowMs: number };

export function ThreadsNeedingAttention({ threads, totalCount, nowMs }: Props) {
  if (threads.length === 0) {
    return (
      <div className="border-border bg-card rounded-2xl border px-5 py-5">
        <div className="text-foreground text-base font-bold">
          Threads needing attention
        </div>
        <p className="text-muted-foreground mt-3 text-sm">
          No threads waiting — nice work.
        </p>
      </div>
    );
  }

  return (
    <div className="border-border bg-card rounded-2xl border px-5 py-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-foreground text-base font-bold">
          Threads needing attention
        </h2>
        <span className="text-muted-foreground rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold tabular-nums">
          {totalCount}
        </span>
      </div>
      <ul className="divide-border divide-y">
        {threads.map((t) => (
          <li key={t.property_id} className="py-3 first:pt-0 last:pb-0">
            <Link
              href={`/leads/${t.property_id}`}
              className="-mx-2 block rounded-lg px-2 py-1 hover:bg-stone-50"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate text-sm font-bold">
                    {homeownerLabel(t)}
                  </div>
                  <div className="text-muted-foreground truncate text-xs font-medium">
                    {[t.address, t.city, t.state].filter(Boolean).join(", ")}
                  </div>
                  {t.last_ai_escalation_reason && (
                    <div className="text-muted-foreground mt-1 truncate text-xs italic">
                      {humanizeMachineValue(t.last_ai_escalation_reason)}
                    </div>
                  )}
                </div>
                {t.last_ai_escalation_at && (
                  <RelativeTime
                    iso={t.last_ai_escalation_at}
                    breached={isOlderThan(
                      t.last_ai_escalation_at,
                      60 * 60 * 1000,
                      nowMs,
                    )}
                    className="shrink-0 text-xs font-medium"
                  />
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {totalCount > threads.length && (
        <Link
          href="/messages?filter=escalated"
          className="text-foreground mt-4 block text-center text-sm font-bold underline-offset-4 hover:underline"
        >
          View all ({totalCount}) →
        </Link>
      )}
    </div>
  );
}

function homeownerLabel(t: ThreadRow): string {
  if (t.homeowner_entity_name) return t.homeowner_entity_name;
  const first = t.homeowner_first_name?.trim();
  const last = t.homeowner_last_name?.trim();
  if (first && last) return `${first} ${last.charAt(0)}.`;
  if (first) return first;
  if (last) return last;
  return "Unknown owner";
}
