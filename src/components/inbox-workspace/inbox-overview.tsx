"use client";
import { useEffect, useState } from "react";
import { createInboxQueryCache, type InboxQueryIdentity } from "@/lib/inbox/workspace-query";
import { useInboxAccessLease } from "./use-access-lease";
import type { InboxCounts } from "@/lib/inbox/filter-contract";
const filters = [["all", "All conversations"], ["unread", "Unread"], ["needs_outcome", "Needs outcome"], ["mine", "Assigned to me"], ["unassigned", "Unassigned"]] as const;
export function InboxOverview({ identity }: { identity: InboxQueryIdentity & { expiresAt: number } }) {
  const access = useInboxAccessLease(identity);
  const authorized = access === "valid";
  const [counts, setCounts] = useState<InboxCounts | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!authorized) return;
    const cache = createInboxQueryCache(identity);
    let active = true;
    const expiry = setTimeout(() => { active = false; cache.close(); setCounts(null); setError(true); }, Math.max(0, identity.expiresAt - Date.now()));
    void cache.read<InboxCounts>("counts", "overview", async signal => {
      const response = await fetch(`/api/inbox/counts?orgId=${identity.orgId}&view=all&hide_noise=true`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), credentials: "same-origin", cache: "no-store", redirect: "error" });
      if (!response.ok) throw Error("Counts unavailable");
      const value = await response.json();
      if (value.accessEpoch !== identity.accessEpoch) throw Error("Access changed");
      return value;
    }).then(value => { if (active) setCounts(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; clearTimeout(expiry); cache.close(); setCounts(null); };
  }, [identity, attempt, authorized]);
  return <main className="min-h-dvh bg-background p-6 md:p-10"><a href="/messages">← Back to Messages</a>
    <div className="my-8 flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">Inbox overview</h1><p>Choose the conversations you want to work on.</p></div><a className="rounded-lg bg-primary px-5 py-3 text-primary-foreground" href="/inbox">Open Inbox workspace</a></div>
    <h2 className="mb-3 text-lg font-medium">Work filters</h2><p className="mb-4 text-sm text-muted-foreground">A conversation can appear in more than one filter.</p>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">{filters.map(([view, label]) => <a key={view} href={`/inbox?view=${view}`} className="rounded-xl border p-5"><h3>{label}</h3><strong className="mt-3 block text-3xl">{authorized && counts ? counts.counts[view] : "—"}</strong></a>)}</div>
    {(access === "denied" || access === "unavailable") && <button className="mt-4 underline" onClick={() => window.location.reload()}>Reload overview</button>}
    {error && authorized && <button className="mt-4 underline" onClick={() => { setCounts(null); setError(false); setAttempt(value => value + 1); }}>Retry counts</button>}
    <p role="status" className="mt-4 text-sm text-muted-foreground">{authorized && counts ? `Counted at ${new Date(counts.asOf).toLocaleTimeString()}` : !authorized ? "Verifying access. Counts are hidden until access is confirmed." : error ? "Counts unavailable. You can still open the workspace." : "Loading counts. You can open the workspace now."}</p>
  </main>;
}
