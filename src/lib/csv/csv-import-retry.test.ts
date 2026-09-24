import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isStaleRunningCsvImport,
  isTerminalCsvImportRetryStatus,
} from "./csv-import-retry";

describe("CSV import retry eligibility", () => {
  afterEach(() => vi.useRealTimers());

  it("treats only a running import beyond the heartbeat allowance as stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T18:10:00.000Z"));

    expect(
      isStaleRunningCsvImport({
        status: "running",
        worker_heartbeat_at: "2026-06-30T18:04:59.999Z",
      }),
    ).toBe(true);
    expect(
      isStaleRunningCsvImport({
        status: "running",
        worker_heartbeat_at: "2026-06-30T18:05:00.000Z",
      }),
    ).toBe(false);
    expect(isStaleRunningCsvImport({ status: "queued" })).toBe(false);
  });

  it("keeps the terminal retry statuses explicit", () => {
    expect(isTerminalCsvImportRetryStatus("failed")).toBe(true);
    expect(isTerminalCsvImportRetryStatus("partial")).toBe(true);
    expect(isTerminalCsvImportRetryStatus("running")).toBe(false);
  });
});
