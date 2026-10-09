// Pure data: the hand-computed oracle for the queue scheduler (plan rule 10 + C26 + G-series).
// No imports from unimplemented modules, so the SQL integration suite can import it too.
// Every instant carries an explicit UTC offset and was verified by reasoning (weekday and DST), not by code.
//
// Cadence (plan v8 rule 10 + C26, Jarrad 2026-10-07). Dates are local dialing dates (Mon-Sat) in the
// current property zone; the anchor is each send's sent_at (send_attempted_at), never completion time.
//  Phase A: first 3 dialing dates with a send. Per date: A_am [09:00,14:00), A_pm [14:00,19:30);
//           at most one send per interval; next send >= previous send + 3h. Phase A ends when its
//           third date is finished (both intervals used, or the date has passed).
//  Phase B: next 12 dialing dates with a send, one per date, from 09:00 of the next dialing date.
//  Phase C: last send's local date + 1 month (clamped to month end) at 09:00, rolled forward to the
//           next dialing date; 6 sends; then exhausted.
// A send is in A_am when its local time is before 14:00, otherwise A_pm.

export type SchedulerFixture = {
  name: string;
  state: string;
  sends: string[];
  now: string;
  expected:
    | { kind: "slot"; phase: "A" | "B" | "C"; slot: "A_am" | "A_pm" | "B" | "C"; at: string }
    | { kind: "exhausted" }
    | { kind: "unknown_state" };
};

const CDT = "-05:00";
const CST = "-06:00";
const t = (date: string, time: string, offset = CDT) => `${date}T${time}:00${offset}`;

// Phase A over Wed-Fri 7-9 Oct 2026, 09:00 and 14:00 each day.
const PHASE_A_OCT_7 = ["2026-10-07", "2026-10-08", "2026-10-09"].flatMap((d) => [t(d, "09:00"), t(d, "14:00")]);
// Phase B: 12 dialing dates Sat 10 Oct -> Fri 23 Oct (Sundays 11 and 18 skipped).
const PHASE_B_OCT_10 = [
  "2026-10-10", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16",
  "2026-10-17", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23",
].map((d) => t(d, "09:00"));
const A_AND_B = [...PHASE_A_OCT_7, ...PHASE_B_OCT_10];

// Full A+B history ending Wed 2025-12-31 (all CST). A: Mon-Wed 15-17 Dec (09:00 + 14:00).
// B: 12 dialing dates Thu 18 Dec .. Wed 31 Dec (Sundays 21 and 28 skipped; no holiday calendar).
const A_AND_B_DEC_2025 = [
  ...["2025-12-15", "2025-12-16", "2025-12-17"].flatMap((d) => [t(d, "09:00", CST), t(d, "14:00", CST)]),
  ...["2025-12-18", "2025-12-19", "2025-12-20", "2025-12-22", "2025-12-23", "2025-12-24",
    "2025-12-25", "2025-12-26", "2025-12-27", "2025-12-29", "2025-12-30", "2025-12-31"].map((d) => t(d, "09:00", CST)),
];

// Phase A over Mon-Wed 1-3 Mar 2027 (CST, before the 14 Mar spring-forward); also used in Arizona (no DST, -07:00).
const A_MAR_1_CST = ["2027-03-01", "2027-03-02", "2027-03-03"].flatMap((d) => [t(d, "09:00", CST), t(d, "14:00", CST)]);
const A_MAR_1_MST = ["2027-03-01", "2027-03-02", "2027-03-03"].flatMap((d) => [t(d, "09:00", "-07:00"), t(d, "14:00", "-07:00")]);
// Phase B: Thu 4 Mar .. Sat 13 Mar 2027 (9 dialing dates; Sunday 7 skipped).
const B_MAR_4 = ["2027-03-04", "2027-03-05", "2027-03-06", "2027-03-08", "2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12", "2027-03-13"];

const MO_C_THIRD_FIVE = [
  t("2026-11-23", "09:00", CST),
  t("2026-12-23", "09:00", CST),
  t("2027-01-23", "09:00", CST), // Sat: Dec 23 + 1 month lands here
  t("2027-02-25", "09:00", CST),
  t("2027-03-25", "09:00"),
];

export const SCHEDULER_FIXTURES: SchedulerFixture[] = [
  // ---- first call ----
  { name: "first call: queued inside the window dials now", state: "MO", sends: [], now: t("2026-10-07", "10:30"), expected: { kind: "slot", phase: "A", slot: "A_am", at: t("2026-10-07", "10:30") } },
  { name: "first call: queued after close waits for 09:00 next dialing day", state: "MO", sends: [], now: t("2026-10-07", "20:00"), expected: { kind: "slot", phase: "A", slot: "A_am", at: t("2026-10-08", "09:00") } },
  { name: "first call: queued Saturday 19:31 skips Sunday", state: "MO", sends: [], now: t("2026-10-10", "19:31"), expected: { kind: "slot", phase: "A", slot: "A_am", at: t("2026-10-12", "09:00") } },
  { name: "first call: queued Sunday waits for Monday", state: "MO", sends: [], now: t("2026-10-11", "11:00"), expected: { kind: "slot", phase: "A", slot: "A_am", at: t("2026-10-12", "09:00") } },

  // ---- phase A ----
  { name: "A: morning send -> afternoon slot opens at 14:00", state: "MO", sends: [t("2026-10-07", "09:05")], now: t("2026-10-07", "09:30"), expected: { kind: "slot", phase: "A", slot: "A_pm", at: t("2026-10-07", "14:00") } },
  { name: "A: 13:00 send -> afternoon slot at 16:00 (3-hour spacing beats 14:00)", state: "MO", sends: [t("2026-10-07", "13:00")], now: t("2026-10-07", "13:30"), expected: { kind: "slot", phase: "A", slot: "A_pm", at: t("2026-10-07", "16:00") } },
  { name: "A: afternoon-only send -> next dialing day 09:00", state: "MO", sends: [t("2026-10-07", "15:00")], now: t("2026-10-07", "15:30"), expected: { kind: "slot", phase: "A", slot: "A_am", at: t("2026-10-08", "09:00") } },
  { name: "A: two sends on a date -> next dialing day 09:00", state: "MO", sends: [t("2026-10-07", "09:05"), t("2026-10-07", "14:00")], now: t("2026-10-07", "14:30"), expected: { kind: "slot", phase: "A", slot: "A_am", at: t("2026-10-08", "09:00") } },
  { name: "A: a missed afternoon is skipped, never doubled", state: "MO", sends: [t("2026-10-07", "09:05")], now: t("2026-10-07", "19:45"), expected: { kind: "slot", phase: "A", slot: "A_am", at: t("2026-10-08", "09:00") } },
  { name: "A: same-day resume after the afternoon opened dials now", state: "MO", sends: [t("2026-10-07", "09:05")], now: t("2026-10-07", "16:00"), expected: { kind: "slot", phase: "A", slot: "A_pm", at: t("2026-10-07", "16:00") } },
  { name: "A: a webhook arriving the next morning schedules from the send, not the completion", state: "MO", sends: [t("2026-10-07", "09:05")], now: t("2026-10-08", "10:00"), expected: { kind: "slot", phase: "A", slot: "A_am", at: t("2026-10-08", "10:00") } },
  { name: "A: the third date keeps its afternoon slot (C26)", state: "MO", sends: [...PHASE_A_OCT_7.slice(0, 4), t("2026-10-09", "09:00")], now: t("2026-10-09", "10:30"), expected: { kind: "slot", phase: "A", slot: "A_pm", at: t("2026-10-09", "14:00") } },
  // Send in MO (16:05Z = 11:05 CDT), property state later edited to CA: 16:05Z is 09:05 PDT, so A_pm opens at 14:00 PDT = 21:00Z
  // (under MO, 3-hour spacing from the 11:05 CDT send makes it 14:05 CDT = 19:05Z).
  { name: "A: property state edited between sends uses the current zone (CA)", state: "CA", sends: ["2026-10-07T16:05:00Z"], now: "2026-10-07T16:30:00Z", expected: { kind: "slot", phase: "A", slot: "A_pm", at: "2026-10-07T21:00:00Z" } },

  // ---- Arizona (no DST, -07:00 all year) ----
  { name: "AZ A: 09:00 send -> A_pm at 14:00 MST", state: "AZ", sends: [t("2026-10-07", "09:00", "-07:00")], now: t("2026-10-07", "09:30", "-07:00"), expected: { kind: "slot", phase: "A", slot: "A_pm", at: t("2026-10-07", "14:00", "-07:00") } },
  { name: "AZ A: both intervals used -> next dialing day 09:00 MST", state: "AZ", sends: [t("2026-10-07", "09:00", "-07:00"), t("2026-10-07", "14:00", "-07:00")], now: t("2026-10-07", "14:30", "-07:00"), expected: { kind: "slot", phase: "A", slot: "A_am", at: t("2026-10-08", "09:00", "-07:00") } },
  { name: "AZ A: third date finished -> phase B next dialing date", state: "AZ", sends: A_MAR_1_MST, now: t("2027-03-03", "14:30", "-07:00"), expected: { kind: "slot", phase: "B", slot: "B", at: t("2027-03-04", "09:00", "-07:00") } },
  { name: "AZ B: across 14 Mar the offset stays -07:00 (Sat -> Mon)", state: "AZ", sends: [...A_MAR_1_MST, ...B_MAR_4.map((d) => t(d, "09:00", "-07:00"))], now: t("2027-03-13", "09:30", "-07:00"), expected: { kind: "slot", phase: "B", slot: "B", at: t("2027-03-15", "09:00", "-07:00") } },

  // ---- phase B ----
  { name: "B: six phase-A sends -> phase B on the next dialing date", state: "MO", sends: PHASE_A_OCT_7, now: t("2026-10-09", "14:30"), expected: { kind: "slot", phase: "B", slot: "B", at: t("2026-10-10", "09:00") } },
  { name: "B: third date with only a morning send moves to B once that date has passed", state: "MO", sends: [t("2026-10-07", "09:00"), t("2026-10-08", "09:00"), t("2026-10-09", "09:00")], now: t("2026-10-09", "20:00"), expected: { kind: "slot", phase: "B", slot: "B", at: t("2026-10-10", "09:00") } },
  { name: "B: skips Sunday", state: "MO", sends: [...PHASE_A_OCT_7, t("2026-10-10", "09:00")], now: t("2026-10-10", "09:30"), expected: { kind: "slot", phase: "B", slot: "B", at: t("2026-10-12", "09:00") } },
  { name: "B: a missed B date is skipped; an overdue slot dials now", state: "MO", sends: [...PHASE_A_OCT_7, t("2026-10-10", "09:00")], now: t("2026-10-13", "11:00"), expected: { kind: "slot", phase: "B", slot: "B", at: t("2026-10-13", "11:00") } },
  // 2027 DST starts Sun 14 Mar (second Sunday: Mar 1 is a Monday). Sat 13 Mar 09:00 CST -> Mon 15 Mar 09:00 CDT.
  { name: "B: spring forward over 14 Mar 2027 (CST send -> next CDT 09:00)", state: "MO", sends: [...A_MAR_1_CST, ...B_MAR_4.map((d) => t(d, "09:00", CST))], now: t("2027-03-13", "09:30", CST), expected: { kind: "slot", phase: "B", slot: "B", at: t("2027-03-15", "09:00") } },

  // ---- phase C and exhaustion ----
  { name: "C: after 12 B dates -> last send date + 1 month at 09:00 (across the fall-back)", state: "MO", sends: A_AND_B, now: t("2026-10-23", "09:30"), expected: { kind: "slot", phase: "C", slot: "C", at: t("2026-11-23", "09:00", CST) } },
  {
    name: "C: a monthly slot landing on Sunday rolls to Monday",
    state: "MO",
    sends: [
      ...["2026-10-13", "2026-10-14", "2026-10-15"].flatMap((d) => [t(d, "09:00"), t(d, "14:00")]),
      ...["2026-10-16", "2026-10-17", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"].map((d) => t(d, "09:00")),
    ],
    now: t("2026-10-29", "10:00"),
    expected: { kind: "slot", phase: "C", slot: "C", at: t("2026-11-30", "09:00", CST) },
  },
  { name: "C: clamps a month-end anchor (31 Mar -> 30 Apr)", state: "MO", sends: [...A_AND_B, t("2027-03-31", "09:00")], now: t("2027-03-31", "09:30"), expected: { kind: "slot", phase: "C", slot: "C", at: t("2027-04-30", "09:00") } },
  // Jan 31 2026 is a Saturday; Feb 2026 has 28 days, so +1 month clamps to Sat 28 Feb (a dialing day).
  { name: "C: Jan 31 anchor clamps to Feb 28 (full A+B history first)", state: "MO", sends: [...A_AND_B_DEC_2025, t("2026-01-31", "09:00", CST)], now: t("2026-01-31", "09:30", CST), expected: { kind: "slot", phase: "C", slot: "C", at: t("2026-02-28", "09:00", CST) } },
  { name: "C: five C sends still schedule a sixth", state: "MO", sends: [...A_AND_B, ...MO_C_THIRD_FIVE], now: t("2027-03-25", "09:30"), expected: { kind: "slot", phase: "C", slot: "C", at: t("2027-04-26", "09:00") } },
  { name: "C: six C sends -> exhausted", state: "MO", sends: [...A_AND_B, ...MO_C_THIRD_FIVE, t("2027-04-26", "09:00")], now: t("2027-04-26", "09:30"), expected: { kind: "exhausted" } },

  // ---- unknown zone ----
  { name: "unknown zone fails closed", state: "ZZ", sends: [], now: "2026-10-07T15:00:00Z", expected: { kind: "unknown_state" } },
];
