import { describe, expect, it } from "vitest";

import { floorZonesForState, formatSlotLabel, hasSlotToken, planSlot } from "./slot-time";

const CHI = "America/Chicago";
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const PHX = "America/Phoenix";

describe("planSlot", () => {
  it("offers ~2h out, rounded up to the quarter hour, in the seller's zone", () => {
    // 13:07 CDT -> 15:07 -> 15:15
    const p = planSlot(new Date("2026-10-14T18:07:00Z"), CHI);
    expect(p).toMatchObject({ kind: "send_now", label: "3:15" });
    expect(p.slotAt.toISOString()).toBe("2026-10-14T20:15:00.000Z");
  });

  it("an exact quarter stays put (13:00 -> 3:00)", () => {
    expect(planSlot(new Date("2026-10-14T18:00:00Z"), CHI)).toMatchObject({ kind: "send_now", label: "3:00" });
  });

  it("one minute past a quarter rounds up (13:01 -> 3:15)", () => {
    expect(planSlot(new Date("2026-10-14T18:01:00Z"), CHI)).toMatchObject({ kind: "send_now", label: "3:15" });
  });

  it("the same instant gives different local slots by seller time zone", () => {
    const now = new Date("2026-10-14T16:00:00Z"); // 12:00 NY, 11:00 CHI, 9:00 LA
    expect(planSlot(now, NY).label).toBe("2:00");
    expect(planSlot(now, CHI).label).toBe("1:00");
    const la = planSlot(now, LA); // slot 11:00 LA is inside "any"
    expect(la).toMatchObject({ kind: "send_now", label: "11:00" });
  });

  it("the last slot of the day is 5:00 (15:00 send)", () => {
    expect(planSlot(new Date("2026-10-14T20:00:00Z"), CHI)).toMatchObject({ kind: "send_now", label: "5:00" });
  });

  it("too late in the day waits until next morning (8:00 send, 10:00 slot)", () => {
    const p = planSlot(new Date("2026-10-14T20:01:00Z"), CHI); // 15:01 -> 17:15 > 17:00
    expect(p.kind).toBe("wait");
    if (p.kind !== "wait") return;
    expect(p.sendAt.toISOString()).toBe("2026-10-15T13:00:00.000Z"); // 08:00 CDT
    expect(p.label).toBe("10:00");
  });

  it("late night past midnight UTC still rolls to the seller's next local morning", () => {
    // 23:30 CDT Oct 14 = 04:30Z Oct 15
    const p = planSlot(new Date("2026-10-15T04:30:00Z"), CHI);
    expect(p.kind).toBe("wait");
    if (p.kind === "wait") expect(p.sendAt.toISOString()).toBe("2026-10-15T13:00:00.000Z");
  });

  it("too early waits until later the same day", () => {
    // 06:00 CDT -> slot 8:00 < 10:00 -> send at 08:00 same day
    const p = planSlot(new Date("2026-10-14T11:00:00Z"), CHI);
    expect(p.kind).toBe("wait");
    if (p.kind === "wait") expect(p.sendAt.toISOString()).toBe("2026-10-14T13:00:00.000Z");
  });

  it("morning window: only slots up to 11:45; later waits for tomorrow morning", () => {
    expect(planSlot(new Date("2026-10-14T14:45:00Z"), CHI, "morning")).toMatchObject({ kind: "send_now", label: "11:45" });
    const p = planSlot(new Date("2026-10-14T14:46:00Z"), CHI, "morning"); // -> 12:00
    expect(p.kind).toBe("wait");
    if (p.kind === "wait") {
      expect(p.sendAt.toISOString()).toBe("2026-10-15T13:00:00.000Z");
      expect(p.label).toBe("10:00");
    }
  });

  it("afternoon window: a morning slot waits until 10:00 send (12:00 slot)", () => {
    const p = planSlot(new Date("2026-10-14T14:00:00Z"), CHI, "afternoon"); // 9:00 -> 11:00
    expect(p.kind).toBe("wait");
    if (p.kind === "wait") {
      expect(p.sendAt.toISOString()).toBe("2026-10-14T15:00:00.000Z"); // 10:00 CDT
      expect(p.label).toBe("12:00");
    }
    expect(planSlot(new Date("2026-10-14T15:00:00Z"), CHI, "afternoon")).toMatchObject({ kind: "send_now", label: "12:00" });
  });

  it("every send_now slot is a quarter hour inside its window, every wait lands inside quiet-hours-open time", () => {
    for (const zone of [CHI, NY, LA, PHX]) {
      for (const window of ["any", "morning", "afternoon"] as const) {
        for (let m = 0; m < 48 * 60; m += 17) {
          const now = new Date(Date.UTC(2026, 2, 7, 0, m)); // spans the 2026-03-08 DST jump
          const p = planSlot(now, zone, window);
          const local = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
            .format(p.slotAt);
          const [h, mm] = local.split(":").map(Number);
          const mins = h! * 60 + mm!;
          expect(mm! % 15).toBe(0);
          const [lo, hi] = window === "morning" ? [600, 705] : window === "afternoon" ? [720, 1020] : [600, 1020];
          expect(mins).toBeGreaterThanOrEqual(lo);
          expect(mins).toBeLessThanOrEqual(hi);
          const lead = (p.slotAt.getTime() - (p.kind === "wait" ? p.sendAt : now).getTime()) / 60000;
          expect(lead).toBeGreaterThanOrEqual(120);
          expect(lead).toBeLessThan(135);
          if (p.kind === "wait") expect(p.sendAt.getTime()).toBeGreaterThan(now.getTime());
        }
      }
    }
  }, 30_000);

  it("DST spring-forward and fall-back days keep the wall-clock slot", () => {
    // 2026-03-08 13:00 CDT (after the jump, UTC-5) -> 3:00
    expect(planSlot(new Date("2026-03-08T18:00:00Z"), CHI).label).toBe("3:00");
    // 2026-11-01 13:00 CST (after fall-back, UTC-6) -> 3:00
    expect(planSlot(new Date("2026-11-01T19:00:00Z"), CHI).label).toBe("3:00");
    // Night before fall-back, too late -> next morning 08:00 CST = 14:00Z
    const p = planSlot(new Date("2026-11-01T03:00:00Z"), CHI); // 22:00 CDT Oct 31
    expect(p.kind).toBe("wait");
    if (p.kind === "wait") expect(p.sendAt.toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });
});

describe("formatSlotLabel / hasSlotToken", () => {
  it("never sends before 08:00 local: 7:46-7:59 rounds to a 10:00 slot but waits until 08:00", () => {
    for (const minute of [46, 50, 59]) {
      // 07:mm CDT = 12:mm UTC
      const p = planSlot(new Date(`2026-10-14T12:${minute}:00Z`), CHI, "any");
      expect(p.kind).toBe("wait");
      if (p.kind === "wait") {
        expect(p.sendAt.toISOString()).toBe("2026-10-14T13:00:00.000Z"); // 08:00 CDT same day
        expect(p.label).toBe("10:00");
      }
    }
    // 08:00 sharp sends now with a 10:00 slot.
    expect(planSlot(new Date("2026-10-14T13:00:00Z"), CHI, "any")).toMatchObject({ kind: "send_now", label: "10:00" });
  });

  it("split-zone state (TX): 07:30 in El Paso (Mountain) waits even though Central is 08:30", () => {
    const now = new Date("2026-10-14T13:30:00Z"); // 08:30 CDT, 07:30 MDT
    expect(planSlot(now, CHI, "any")).toMatchObject({ kind: "send_now", label: "10:30" }); // dominant zone alone
    const p = planSlot(now, CHI, "any", floorZonesForState("TX"));
    expect(p.kind).toBe("wait");
    if (p.kind === "wait") {
      expect(p.sendAt.toISOString()).toBe("2026-10-14T14:00:00.000Z"); // 08:00 Mountain = 09:00 Central
      expect(p.label).toBe("11:00"); // displayed in Central (dominant zone)
    }
    // Once 08:00 has passed everywhere in the state it sends.
    expect(planSlot(new Date("2026-10-14T14:00:00Z"), CHI, "any", floorZonesForState("TX"))).toMatchObject({ kind: "send_now", label: "11:00" });
  });

  it("split-zone next-morning waits also clear the floor in every zone (FL panhandle)", () => {
    // 16:30 EDT -> too late; next morning 08:00 EDT is 07:00 CDT in the panhandle -> 08:00 CDT.
    const p = planSlot(new Date("2026-10-14T20:30:00Z"), NY, "any", floorZonesForState("FL"));
    expect(p.kind).toBe("wait");
    if (p.kind === "wait") expect(p.sendAt.toISOString()).toBe("2026-10-15T13:00:00.000Z");
  });

  it("single-zone states are unchanged", () => {
    expect(floorZonesForState("MO")).toEqual([]);
    expect(floorZonesForState(null)).toEqual([]);
    const now = new Date("2026-10-14T13:30:00Z");
    expect(planSlot(now, CHI, "any", floorZonesForState("MO"))).toEqual(planSlot(now, CHI, "any"));
  });

  it("writes times the way the approved texts do", () => {
    expect(formatSlotLabel(14 * 60)).toBe("2:00");
    expect(formatSlotLabel(11 * 60 + 30)).toBe("11:30");
    expect(formatSlotLabel(12 * 60 + 15)).toBe("12:15");
  });
  it("detects the token", () => {
    expect(hasSlotToken("at {{slot_time}} today")).toBe(true);
    expect(hasSlotToken("at {{ slot_time }} today")).toBe(true);
    expect(hasSlotToken("at 2:00 today")).toBe(false);
  });
});
