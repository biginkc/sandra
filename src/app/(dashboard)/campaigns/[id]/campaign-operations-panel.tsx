import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type CampaignJobSummary = {
  id: string;
  status: string;
  totalItems: number;
  processedItems: number;
  succeededItems: number;
  failedItems: number;
  errorMessage: string | null;
};

export type CampaignOperationsStats = {
  campaignStatus: string;
  audience: number;
  queued: number;
  dueQueued: number;
  pending: number;
  sent: number;
  delivered: number;
  failed: number;
  handedOff: number;
  replied: number;
  optedOut: number;
  nextScheduledFor: string | null;
  lastScheduledFor: string | null;
  paceSeconds: number | null;
  job: CampaignJobSummary | null;
};

type Props = {
  stats: CampaignOperationsStats;
};

export function CampaignOperationsPanel({ stats }: Props) {
  const setupStatus = describeSetupStatus(stats);
  const drainEta = formatDrainEta(stats.lastScheduledFor);

  return (
    <section className="flex flex-col gap-3" data-testid="campaign-live-ops">
      <div>
        <h2 className="text-lg font-bold tracking-normal">Live send progress</h2>
        <p className="text-muted-foreground text-sm">
          Queue setup and message delivery are separate. A built queue can still
          be sending.
        </p>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
            <span>Campaign operations</span>
            <span className="rounded-md border bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
              Queue setup: {setupStatus}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Metric label="Frozen audience" value={stats.audience} />
          <Metric label="Queued to send" value={stats.queued} />
          <Metric label="Due now" value={stats.dueQueued} />
          <Metric label="Pending provider result" value={stats.pending} />
          <Metric label="Handed to provider" value={stats.handedOff} />
          <Metric label="Sent, not yet delivered" value={stats.sent} />
          <Metric label="Delivered" value={stats.delivered} />
          <Metric label="Failed" value={stats.failed} tone="danger" />
          <Metric label="Replies" value={stats.replied} tone="success" />
          <Metric label="Opt-outs" value={stats.optedOut} />
          <Metric
            label="Next send"
            value={formatNextRelease(stats.nextScheduledFor)}
          />
          <Metric label="Drain ETA" value={drainEta} />
        </CardContent>
        <div className="border-t px-6 py-4 text-xs text-muted-foreground">
          {stats.job ? (
            <span>
              Queue-building job: {formatJobStatus(stats.job.status)} ·{" "}
              {stats.job.succeededItems.toLocaleString()} queued,{" "}
              {stats.job.failedItems.toLocaleString()} failed of{" "}
              {stats.job.totalItems.toLocaleString()}
              {stats.job.errorMessage ? ` · ${stats.job.errorMessage}` : ""}
            </span>
          ) : (
            <span>No queue-building job found for this campaign.</span>
          )}
          <span className="ml-3">
            Cadence: {stats.paceSeconds ? `${stats.paceSeconds}s` : "not set"}
          </span>
        </div>
      </Card>
    </section>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "default" | "danger" | "success";
}) {
  const toneClass =
    tone === "danger"
      ? "text-red-700"
      : tone === "success"
        ? "text-emerald-700"
        : "text-foreground";

  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${toneClass}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function describeSetupStatus(stats: CampaignOperationsStats): string {
  const jobStatus = stats.job?.status ?? null;
  if (jobStatus === "queued" || jobStatus === "running" || jobStatus === "finalizing") {
    return "building queue";
  }
  if (jobStatus === "failed") return "queue build failed";
  if (jobStatus === "partial") return "queue built with failures";
  if (stats.queued > 0) return "queue built; still sending";
  if (stats.handedOff + stats.failed > 0) return "send run finished";
  return formatJobStatus(stats.campaignStatus);
}

function formatJobStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function formatNextRelease(iso: string | null): string {
  if (iso === null) return "none queued";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "--";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "now";
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 60) return `in ${diffS}s`;
  return `in ${Math.round(diffS / 60)}m`;
}

function formatDrainEta(iso: string | null): string {
  if (iso === null) return "--";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "--";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "draining now";
  if (diffMs < 60_000) return "<1m";
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
