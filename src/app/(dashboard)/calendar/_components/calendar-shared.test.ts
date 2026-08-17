import { describe, expect, it } from "vitest";

import type { CalendarAppointmentRow } from "../types";

import { appointmentVisualTone, formatTimeRange } from "./calendar-shared";

const CHI = "America/Chicago";

function appt(
  overrides: Partial<CalendarAppointmentRow> = {},
): CalendarAppointmentRow {
  return {
    id: "appt-1",
    title: "Appointment",
    description: null,
    due_at: "2026-08-16T15:00:00.000Z",
    end_at: "2026-08-16T15:30:00.000Z",
    status: "open",
    outcome: null,
    assignee_id: "user-1",
    property_id: null,
    address: null,
    city: null,
    state: null,
    contact_id: null,
    contact_name: null,
    is_dnc_locked: false,
    ...overrides,
  };
}

describe("appointmentVisualTone", () => {
  const before = new Date("2026-08-16T14:00:00.000Z").getTime();
  const after = new Date("2026-08-16T16:00:00.000Z").getTime();

  it("maps property, contact-only, and personal appointments", () => {
    expect(
      appointmentVisualTone(appt({ property_id: "property-1" }), before),
    ).toBe("property");
    expect(
      appointmentVisualTone(appt({ contact_id: "contact-1" }), before),
    ).toBe("contact");
    expect(appointmentVisualTone(appt(), before)).toBe("personal");
  });

  it("lets lifecycle state override linkage", () => {
    expect(
      appointmentVisualTone(appt({ property_id: "property-1" }), after),
    ).toBe("needs_outcome");
    expect(
      appointmentVisualTone(
        appt({ status: "completed", contact_id: "contact-1" }),
        after,
      ),
    ).toBe("completed");
  });
});

describe("formatTimeRange", () => {
  it("renders a normal same-day range unchanged (no marker, no zone abbreviation)", () => {
    expect(
      formatTimeRange(
        "2026-05-05T15:00:00.000Z",
        "2026-05-05T15:30:00.000Z",
        CHI,
      ),
    ).toBe("10:00 AM–10:30 AM");
  });

  it("appends a next-day marker when the zone-local calendar date rolls over (cross-midnight block)", () => {
    // 11:30 PM CDT (May 5) -> 12:15 AM CDT (May 6).
    expect(
      formatTimeRange(
        "2026-05-06T04:30:00.000Z",
        "2026-05-06T05:15:00.000Z",
        CHI,
      ),
    ).toBe("11:30 PM–12:15 AM → Wed");
  });

  it("disambiguates an America/Chicago DST fall-back hour with zone abbreviations (2026-11-01)", () => {
    // Clocks fall back from 2:00 AM CDT to 1:00 AM CST at 2026-11-01
    // 07:00 UTC. 06:30 UTC = 1:30 AM CDT (pre-fallback); 07:30 UTC =
    // 1:30 AM CST (post-fallback) — same wall-clock label, one real hour
    // apart.
    expect(
      formatTimeRange(
        "2026-11-01T06:30:00.000Z",
        "2026-11-01T07:30:00.000Z",
        CHI,
      ),
    ).toBe("1:30 AM CDT–1:30 AM CST");
  });

  it("disambiguates when the DST fall-back makes the end's wall-clock label appear to precede the start's", () => {
    // 1:45 AM CDT (pre-fallback, 06:45 UTC) -> 1:15 AM CST (post-fallback,
    // 07:15 UTC) — 30 real minutes later, but the bare wall-clock labels
    // would read as going backwards without the zone abbreviations.
    expect(
      formatTimeRange(
        "2026-11-01T06:45:00.000Z",
        "2026-11-01T07:15:00.000Z",
        CHI,
      ),
    ).toBe("1:45 AM CDT–1:15 AM CST");
  });

  it("labels a fall-back offset transition even when the end wall-clock is later", () => {
    expect(
      formatTimeRange(
        "2026-11-01T06:30:00.000Z",
        "2026-11-01T08:00:00.000Z",
        "America/Chicago",
      ),
    ).toBe("1:30 AM CDT–2:00 AM CST");
  });

  it("leaves a zero-length range (defensive end_at === due_at fallback) unmarked", () => {
    expect(
      formatTimeRange(
        "2026-05-05T15:00:00.000Z",
        "2026-05-05T15:00:00.000Z",
        CHI,
      ),
    ).toBe("10:00 AM–10:00 AM");
  });
});
