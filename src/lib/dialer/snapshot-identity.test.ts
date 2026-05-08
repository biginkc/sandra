import { describe, expect, it } from "vitest";

import { buildSnapshotsForProperty, normalizeToE164 } from "./snapshot-identity";

const property = (state: string) => ({ id: `property-${state}`, state });
const contact = (phones: {
  phone_1?: string | null;
  phone_2?: string | null;
  phone_3?: string | null;
}) => ({
  id: "contact-1",
  phone_1: phones.phone_1 ?? null,
  phone_2: phones.phone_2 ?? null,
  phone_3: phones.phone_3 ?? null,
});

describe("buildSnapshotsForProperty", () => {
  it("derives America/Chicago timezone for MO", () => {
    const snapshots = buildSnapshotsForProperty(
      property("MO"),
      contact({ phone_1: "5551112222" }),
    );

    expect(snapshots[0]?.timezone).toBe("America/Chicago");
  });

  it("derives America/New_York timezone for OH", () => {
    const snapshots = buildSnapshotsForProperty(
      property("OH"),
      contact({ phone_1: "5551112222" }),
    );

    expect(snapshots[0]?.timezone).toBe("America/New_York");
  });

  it("returns empty array for unknown state", () => {
    expect(
      buildSnapshotsForProperty(
        property("ZZ"),
        contact({ phone_1: "5551112222" }),
      ),
    ).toEqual([]);
  });

  it("creates one snapshot per non-null phone", () => {
    const snapshots = buildSnapshotsForProperty(
      property("MO"),
      contact({ phone_1: "5551112222", phone_3: "5553334444" }),
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((snapshot) => snapshot.phone_label)).toEqual([
      "homeowner.phone_1",
      "homeowner.phone_3",
    ]);
  });

  it("normalizes US 10-digit phones to E.164", () => {
    expect(normalizeToE164("(555) 111-2222")).toBe("+15551112222");
  });

  it("skips contact with no phones", () => {
    expect(buildSnapshotsForProperty(property("MO"), contact({}))).toEqual([]);
  });

  it("skips a phone that cannot be normalized", () => {
    const snapshots = buildSnapshotsForProperty(
      property("MO"),
      contact({ phone_1: "abc", phone_2: "5553334444" }),
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.phone_e164).toBe("+15553334444");
  });

  it("snapshots calling_window default of {8, 21}", () => {
    const snapshots = buildSnapshotsForProperty(
      property("MO"),
      contact({ phone_1: "5551112222" }),
    );

    expect(snapshots[0]).toMatchObject({
      calling_window_start_hour: 8,
      calling_window_end_hour: 21,
    });
  });

  it("trims and uppercases state before lookup", () => {
    const snapshots = buildSnapshotsForProperty(
      property(" mo "),
      contact({ phone_1: "5551112222" }),
    );

    expect(snapshots[0]).toMatchObject({
      state: "MO",
      timezone: "America/Chicago",
    });
  });
});
