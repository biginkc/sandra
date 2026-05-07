import { describe, expect, it } from "vitest";
import { utils as xlsxUtils, write as xlsxWrite } from "xlsx";

import { xlsxBufferToCsvFile } from "./xlsx-to-csv-file";

/** Build a real XLSX `ArrayBuffer` from an array-of-arrays. */
function makeXlsxBuffer(rows: (string | number)[][]): ArrayBuffer {
  const ws = xlsxUtils.aoa_to_sheet(rows);
  const wb = xlsxUtils.book_new();
  xlsxUtils.book_append_sheet(wb, ws, "Sheet1");
  const out = xlsxWrite(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return out;
}

describe("xlsxBufferToCsvFile", () => {
  it("returns a File with type='text/csv' (not the original xlsx bytes)", async () => {
    const buf = makeXlsxBuffer([
      ["Address", "State", "Phone"],
      ["123 Main St", "MO", "8165551001"],
    ]);
    const file = xlsxBufferToCsvFile(buf, "October_2024_Propstream_Mailing.xlsx");

    expect(file.type).toBe("text/csv");
    expect(file.name).toBe("October_2024_Propstream_Mailing.csv");
    // The fix: the bytes in the File MUST be CSV text, not XLSX binary.
    // XLSX magic is 0x504b ("PK") — assert the first bytes are ASCII
    // header text, NOT the ZIP/XLSX signature.
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(bytes[0]).not.toBe(0x50); // not 'P' of 'PK'
    expect(new TextDecoder().decode(bytes.slice(0, 7))).toBe("Address");
  });

  it("preserves the row data verbatim through the CSV conversion", async () => {
    const buf = makeXlsxBuffer([
      ["Address", "State"],
      ["123 Main St", "MO"],
      ["456 Oak Ave", "KS"],
    ]);
    const file = xlsxBufferToCsvFile(buf, "test.xlsx");
    const text = await file.text();

    expect(text).toContain("Address,State");
    expect(text).toContain("123 Main St,MO");
    expect(text).toContain("456 Oak Ave,KS");
  });

  it("handles XLSX files where the source name lacks the .xlsx extension", async () => {
    const buf = makeXlsxBuffer([["A"], ["1"]]);
    const file = xlsxBufferToCsvFile(buf, "weirdly-named-file");
    // No .xlsx → no replacement → name passes through unchanged
    // (consumers can rename if they want a .csv suffix).
    expect(file.name).toBe("weirdly-named-file");
    expect(file.type).toBe("text/csv");
  });

});
