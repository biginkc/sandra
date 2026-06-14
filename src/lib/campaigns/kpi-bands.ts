export type CampaignKpiMetric = "delivered" | "reply" | "failed" | "optOut";
export type CampaignKpiBand = "green" | "yellow" | "red";

export function getCampaignKpiBand(
  metric: CampaignKpiMetric,
  value: number,
): CampaignKpiBand {
  switch (metric) {
    case "delivered":
      if (value >= 97) return "green";
      if (value >= 95) return "yellow";
      return "red";
    case "reply":
      if (value >= 10) return "green";
      if (value >= 8) return "yellow";
      return "red";
    case "failed":
      if (value < 10) return "green";
      if (value < 12) return "yellow";
      return "red";
    case "optOut":
      if (value < 2) return "green";
      if (value < 3) return "yellow";
      return "red";
  }
}
