export const CSV_IMPORT_STALE_AFTER_MS = 5 * 60 * 1000;

export type CsvImportRetryState = {
  status: string;
  worker_heartbeat_at?: string | null;
};

export function isStaleRunningCsvImport(job: CsvImportRetryState): boolean {
  if (job.status !== "running") return false;
  if (!job.worker_heartbeat_at) return true;

  return (
    Date.now() - new Date(job.worker_heartbeat_at).getTime() >
    CSV_IMPORT_STALE_AFTER_MS
  );
}

export function isTerminalCsvImportRetryStatus(status: string): boolean {
  return ["failed", "partial", "partially_completed"].includes(status);
}
