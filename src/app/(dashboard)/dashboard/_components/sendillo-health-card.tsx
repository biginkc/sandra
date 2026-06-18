import type {
  SendilloSmsHealth,
  SendilloSmsHealthResult,
} from "@/lib/messages/sendillo-health";

type Props = {
  result: SendilloSmsHealthResult;
};

export function SendilloHealthCard({ result }: Props) {
  const health = result.health;

  return (
    <section
      aria-labelledby="sendillo-health-heading"
      className="border-border bg-card rounded-2xl border px-6 py-5"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="sendillo-health-heading" className="text-foreground text-base font-bold">
            Sendillo SMS health
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Sendillo-era SMS only. Dialpad history is excluded.
          </p>
        </div>
        <p className="text-muted-foreground text-xs font-medium">
          {result.status === "available" ? formatWindow(health) : "Unavailable"}
        </p>
      </div>

      {result.status === "available" ? (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <MetricTile
            label="Outbound / inbound SMS rows"
            value={`${health.outboundMessages.toLocaleString()} / ${health.inboundMessages.toLocaleString()}`}
            helper={`${health.smsRows.toLocaleString()} total Sendillo rows`}
          />
          <MetricTile
            label="Sendillo conversations"
            value={health.conversations.toLocaleString()}
            helper="Non-queued SMS threads"
          />
          <MetricTile
            label="Inbound SMS rows"
            value={health.inboundMessages.toLocaleString()}
            helper={`${health.anyInboundMissingDisposition.toLocaleString()} inbound-reply threads still have no disposition`}
          />
          <MetricTile
            label="Needs disposition"
            value={health.latestInboundMissingDisposition.toLocaleString()}
            helper="Latest reply is inbound"
          />
          <MetricTile
            label="Unread needs disposition"
            value={health.unreadMissingDisposition.toLocaleString()}
            helper="Unread inbound on an undispositioned property"
          />
          <MetricTile
            label="Human attention"
            value={health.humanAttentionMissingDisposition.toLocaleString()}
            helper="Flagged and still undispositioned"
          />
        </div>
      ) : (
        <div className="bg-muted/40 mt-5 rounded-lg px-4 py-5">
          <div className="text-foreground text-sm font-bold">
            Sendillo SMS health unavailable
          </div>
          <div className="text-muted-foreground mt-1 text-xs font-medium">
            Refresh later or check server logs before trusting the Sendillo KPI totals.
          </div>
        </div>
      )}
    </section>
  );
}

function MetricTile({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="bg-muted/40 rounded-lg px-4 py-3">
      <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
        {label}
      </div>
      <div className="text-foreground mt-2 text-3xl font-extrabold tracking-tight tabular-nums">
        {value}
      </div>
      <div className="text-muted-foreground mt-1 text-xs font-medium">{helper}</div>
    </div>
  );
}

function formatWindow(health: SendilloSmsHealth): string {
  if (!health.firstMessageAt || !health.latestMessageAt) return "No Sendillo rows yet";
  return `${formatDate(health.firstMessageAt)} - ${formatDate(health.latestMessageAt)}`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}
