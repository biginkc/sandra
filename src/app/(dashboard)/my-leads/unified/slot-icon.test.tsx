import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkDrip } from "./contract";
import { SlotIconView, slotIconFor, SLOT_ICON_LABELS } from "./slot-icon";
import { workFacts } from "./test-support";

const healthy = { enrollmentId: "e", status: "active", pauseReason: null, name: "x", step: 1, stepsTotal: 3, nextRunAt: null, completedAt: null, lastSentAt: null, healthy: true } satisfies WorkDrip;
const unanswered = { at: "2026-10-14T14:00:00Z", kind: "text" as const, messageId: "m", handled: false, contactOnly: false };
const broken = [{ kind: "text_not_sent" as const, action: "resend" as const, at: null, refId: "r" }];

describe("slotIconFor priority", () => {
  it("new reply beats everything", () => {
    const f = workFacts("due", "4", {}, { latestInbound: unanswered, broken, stage: "not_contacted", drip: healthy });
    expect(slotIconFor(f)).toBe("new_reply");
  });
  it("broken beats new lead and drip", () => {
    expect(slotIconFor(workFacts("broken", "6", {}, { broken, stage: "not_contacted", drip: healthy }))).toBe("broken");
    expect(slotIconFor(workFacts("due", "4", {}, { labels: ["broken"] }))).toBe("broken");
  });
  it("new lead beats drip", () => {
    expect(slotIconFor(workFacts("new_lead", "3", {}, { stage: "not_contacted", drip: healthy }))).toBe("new_lead");
  });
  it("a called not-contacted lead is not a new lead", () => {
    expect(slotIconFor(workFacts("nothing_planned", "15", {}, { stage: "not_contacted", attemptsCount: 1 }))).toBe("no_drip");
  });
  it("healthy drip, else not in a drip", () => {
    expect(slotIconFor(workFacts("in_drip", "10", {}, { drip: healthy }))).toBe("in_drip");
    expect(slotIconFor(workFacts("nothing_planned", "15", {}, { drip: { ...healthy, healthy: false } }))).toBe("no_drip");
    expect(slotIconFor(workFacts("nothing_planned", "15"))).toBe("no_drip");
  });
  it("a handled or contact-only inbound does not take the first slot", () => {
    expect(slotIconFor(workFacts("texted_last", "13", {}, { latestInbound: { ...unanswered, handled: true } }))).toBe("no_drip");
    expect(slotIconFor(workFacts("nothing_planned", "15", {}, { latestInbound: { ...unanswered, contactOnly: true } }))).toBe("no_drip");
  });
});

describe("slotIconFor contact-only inbound", () => {
  const contactOnly = { ...unanswered, contactOnly: true };
  it("keeps not-in-a-drip even for a new lead or healthy drip", () => {
    expect(slotIconFor(workFacts("new_lead", "3", {}, { latestInbound: contactOnly, stage: "not_contacted", drip: healthy }))).toBe("no_drip");
    expect(slotIconFor(workFacts("in_drip", "10", {}, { latestInbound: contactOnly, drip: healthy }))).toBe("no_drip");
  });
  it("a handled contact-only inbound no longer forces not-in-a-drip", () => {
    const handled = { ...contactOnly, handled: true };
    expect(slotIconFor(workFacts("in_drip", "10", {}, { latestInbound: handled, drip: healthy }))).toBe("in_drip");
    expect(slotIconFor(workFacts("new_lead", "3", {}, { latestInbound: handled, stage: "not_contacted", drip: null }))).toBe("new_lead");
  });
  it("broken still wins", () => {
    expect(slotIconFor(workFacts("broken", "6", {}, { latestInbound: contactOnly, broken }))).toBe("broken");
  });
});

describe("<SlotIconView />", () => {
  it.each(Object.keys(SLOT_ICON_LABELS) as (keyof typeof SLOT_ICON_LABELS)[])("%s has an accessible name", (icon) => {
    render(<SlotIconView icon={icon} />);
    expect(screen.getByRole("img", { name: SLOT_ICON_LABELS[icon] })).toHaveAttribute("data-slot-icon", icon);
  });
});
