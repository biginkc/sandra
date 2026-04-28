/**
 * Tiny CSV export helpers for the Update wizard's preview step. We avoid
 * pulling in a CSV writer dep (papaparse can stringify, but it adds bulk
 * to the client bundle for a one-off use). The escape rules below are the
 * RFC-4180 minimum — quote any field containing ",", '"', '\n', or '\r';
 * inside a quoted field, double the quote character.
 */

export type CsvRow = Record<string, string | number | null | undefined>;

function escapeCell(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows: CsvRow[], headers?: string[]): string {
  if (rows.length === 0 && !headers) return "";
  const cols = headers ?? uniqueKeys(rows);
  const lines = [cols.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCell(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

function uniqueKeys(rows: CsvRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return Array.from(seen);
}

/**
 * Browser-only: trigger a download of the given CSV string. The Blob is
 * URL-revoked on next tick to free memory.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Browser-only: copy text to clipboard. Returns whether it succeeded. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
