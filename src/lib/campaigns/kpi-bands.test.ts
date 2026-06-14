import { describe, expect, it } from "vitest";

import { getCampaignKpiBand, type CampaignKpiMetric } from "./kpi-bands";

describe("getCampaignKpiBand", () => {
  it.each<{ metric: CampaignKpiMetric; value: number; expected: string }>([
    { metric: "delivered", value: 97, expected: "green" },
    { metric: "delivered", value: 96.9, expected: "yellow" },
    { metric: "delivered", value: 95, expected: "yellow" },
    { metric: "delivered", value: 94.9, expected: "red" },
    { metric: "reply", value: 10, expected: "green" },
    { metric: "reply", value: 9.9, expected: "yellow" },
    { metric: "reply", value: 8, expected: "yellow" },
    { metric: "reply", value: 7.9, expected: "red" },
    { metric: "failed", value: 9.9, expected: "green" },
    { metric: "failed", value: 10, expected: "yellow" },
    { metric: "failed", value: 11.9, expected: "yellow" },
    { metric: "failed", value: 12, expected: "red" },
    { metric: "optOut", value: 1.9, expected: "green" },
    { metric: "optOut", value: 2, expected: "yellow" },
    { metric: "optOut", value: 2.9, expected: "yellow" },
    { metric: "optOut", value: 3, expected: "red" },
  ])("maps $metric at $value to $expected", ({ metric, value, expected }) => {
    expect(getCampaignKpiBand(metric, value)).toBe(expected);
  });
});
