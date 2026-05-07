import { describe, expect, it } from "vitest";

import { titleproPreset } from "./titlepro";

const AD_HEADERS = [
  "Site Address", "Site City/State/Zip Code", "APN", "APN (text)",
  "1st Owner's First Name", "1st Owner's Last Name",
  "AD.type", "AD.file_date", "AD.insert_date", "AD.deceased",
];
const LP_HEADERS = [
  "Site Address", "APN",
  "1st Owner's First Name", "1st Owner's Last Name",
  "LP.type", "LP.file_date", "LP.insert_date", "LP.delinquent_amount",
];

describe("titleproPreset.detect", () => {
  it("returns 1.0 for full AD.* signature", () => {
    const r = titleproPreset.detect(AD_HEADERS, []);
    expect(r?.id).toBe("titlepro");
    expect(r?.confidence).toBe(1.0);
    expect(r?.subtype).toBe("titlepro-death");
  });
  it("returns 1.0 for full LP.* signature with subtype", () => {
    const r = titleproPreset.detect(LP_HEADERS, []);
    expect(r?.subtype).toBe("titlepro-lis-pendens");
  });
  it("mixed AD + LP prefixes drops confidence below threshold", () => {
    const mixed = [
      "Site Address", "APN",
      "AD.type", "AD.file_date",
      "LP.type", "LP.file_date",
    ];
    const r = titleproPreset.detect(mixed, []);
    expect(r?.confidence ?? 0).toBeLessThan(0.7);
  });
  it("empty headers → null", () => {
    expect(titleproPreset.detect([], [])).toBeNull();
  });
  it("missing .file_date → null even with .type present", () => {
    expect(titleproPreset.detect(["AD.type"], [])).toBeNull();
  });
});

describe("titleproPreset.transform — APN merge", () => {
  it("merges APN + APN (text); strips Excel armor", () => {
    const rows = [{
      APN: "6.11E+18",
      "APN (text)": '="611000000123456789"',
      "1st Owner's First Name": "Jane",
      "1st Owner's Last Name": "Smith",
      "AD.type": "Death", "AD.file_date": "2026-01-15", "AD.insert_date": "2026-01-16",
    }];
    const r = titleproPreset.transform(rows, AD_HEADERS);
    expect(r.rows[0].APN).toBe("611000000123456789");
    expect(r.rows[0]["APN (text)"]).toBeUndefined();
    expect(r.stats.columnsRemoved).toContain("APN (text)");
  });
});

describe("titleproPreset.transform — dedup", () => {
  it("collapses duplicate rows by (APN, prefix, file_date), keeps most recent insert_date", () => {
    const base = {
      APN: "12345",
      "1st Owner's First Name": "Jane",
      "1st Owner's Last Name": "Smith",
      "AD.type": "Death", "AD.file_date": "2026-01-15",
    };
    const rows = [
      { ...base, "AD.insert_date": "2026-01-16" },
      { ...base, "AD.insert_date": "2026-01-20" }, // newer
      { ...base, "AD.insert_date": "2026-01-18" },
    ];
    const r = titleproPreset.transform(rows, AD_HEADERS);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]["AD.insert_date"]).toBe("2026-01-20");
    expect(r.stats.rowsCollapsedDup).toBe(2);
  });
  it("keeps rows with un-normalizable APN (no dedup risk)", () => {
    const rows = [
      { APN: "", "AD.type": "Death", "AD.file_date": "2026-01-15", "AD.insert_date": "2026-01-16" },
      { APN: "", "AD.type": "Death", "AD.file_date": "2026-01-15", "AD.insert_date": "2026-01-20" },
    ];
    const r = titleproPreset.transform(rows, AD_HEADERS);
    expect(r.rows.length).toBe(2);
    expect(r.stats.rowsCollapsedDup).toBe(0);
  });
});

describe("titleproPreset.transform — owner mapping + suggestions", () => {
  it("maps 1st Owner's First/Last → homeowner_first/last_name", () => {
    const rows = [{
      APN: "12345",
      "1st Owner's First Name": "Jane",
      "1st Owner's Last Name": "Smith",
      "AD.type": "Death", "AD.file_date": "2026-01-15", "AD.insert_date": "2026-01-16",
    }];
    const r = titleproPreset.transform(rows, AD_HEADERS);
    expect(r.rows[0].homeowner_first_name).toBe("Jane");
    expect(r.rows[0].homeowner_last_name).toBe("Smith");
  });
  it("AD.* preset → titlepro source + Death list-name + titlepro-death tag", () => {
    const rows = [{
      APN: "12345",
      "AD.type": "Death", "AD.file_date": "2026-04-15", "AD.insert_date": "2026-04-16",
    }];
    const r = titleproPreset.transform(rows, AD_HEADERS);
    expect(r.suggestions?.sourceSuggestion).toBe("titlepro");
    expect(r.suggestions?.listNameSuggestion).toContain("Death");
    expect(r.suggestions?.tags).toContain("titlepro-death");
  });
});
