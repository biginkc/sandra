import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getCampaignKpiBand, type CampaignKpiBand, type CampaignKpiMetric } from "@/lib/campaigns/kpi-bands";

type CampaignKpis = {
  audience: number;
  attempted: number;
  delivered: number;
  delivered_rate: number;
  failed: number;
  failed_rate: number;
  replied: number;
  reply_rate: number;
  opted_out: number;
  opt_out_rate: number;
};

type Props = {
  kpis: CampaignKpis;
};

type MetricCard = {
  key: CampaignKpiMetric;
  label: string;
  rate: number;
  count: number;
  countLabel: string;
  description: string;
};

const CARD_TONES: Record<CampaignKpiBand, string> = {
  green: "border-emerald-200 bg-emerald-50/70 text-emerald-950",
  yellow: "border-amber-200 bg-amber-50/80 text-amber-950",
  red: "border-red-200 bg-red-50/80 text-red-950",
};

const RATE_TONES: Record<CampaignKpiBand, string> = {
  green: "text-emerald-700",
  yellow: "text-amber-700",
  red: "text-red-700",
};

export function CampaignScoreboard({ kpis }: Props) {
  const cards: MetricCard[] = [
    {
      key: "reply",
      label: "Reply",
      rate: kpis.reply_rate,
      count: kpis.replied,
      countLabel: "contacts replied",
      description: "Green at 10%+",
    },
    {
      key: "delivered",
      label: "Delivered",
      rate: kpis.delivered_rate,
      count: kpis.delivered,
      countLabel: "properties delivered",
      description: "Green at 97%+",
    },
    {
      key: "failed",
      label: "Failed",
      rate: kpis.failed_rate,
      count: kpis.failed,
      countLabel: "properties failed",
      description: "Green below 10%",
    },
    {
      key: "optOut",
      label: "Opt-out",
      rate: kpis.opt_out_rate,
      count: kpis.opted_out,
      countLabel: "contacts opted out",
      description: "Green below 2%",
    },
  ];

  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        {cards.map((card) => {
          const band = getCampaignKpiBand(card.key, card.rate);
          const isReplyHero = card.key === "reply";
          return (
            <Card
              key={card.key}
              data-band={band}
              data-testid={`campaign-kpi-card-${card.key}`}
              className={cn(
                "border",
                CARD_TONES[band],
                isReplyHero && "lg:col-span-2",
              )}
            >
              <CardHeader className="border-b border-black/5">
                <CardTitle>{card.label}</CardTitle>
                <CardDescription className="text-current/70">
                  {card.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex items-end justify-between gap-4">
                  <div
                    className={cn(
                      "font-extrabold tracking-tight tabular-nums",
                      isReplyHero ? "text-5xl" : "text-4xl",
                      RATE_TONES[band],
                    )}
                  >
                    {formatPercent(card.rate)}
                  </div>
                  <div className="text-right text-sm text-current/80">
                    {card.count.toLocaleString()} {card.countLabel}
                  </div>
                </div>
                <div className="text-xs font-medium text-current/80">
                  Provider attempted {kpis.attempted.toLocaleString()} of{" "}
                  {kpis.audience.toLocaleString()} audience
                </div>
                {card.key === "failed" && band !== "green" ? (
                  <div className="rounded-md border border-current/15 bg-white/55 px-3 py-2 text-xs font-medium">
                    Consider provisioning a new sending number
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="text-muted-foreground text-xs">
        Delivery rates dedupe by property. Reply and opt-out rates dedupe by contact.
      </div>
    </section>
  );
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1,
  }).format(value)}%`;
}
