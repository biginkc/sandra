export type DropboxFilesErrorDisposition = {
  retryable: boolean;
  reason: "files_preparing" | "rate_limited" | "provider_unavailable" | "rejected";
  retryAfterSeconds: number | null;
};

export function classifyDropboxSignFilesError(input: {
  statusCode: number | null | undefined;
  retryAfter: string | number | null | undefined;
}): DropboxFilesErrorDisposition {
  const retryAfterSeconds = parseRetryAfter(input.retryAfter);
  if (input.statusCode === 409) {
    return { retryable: true, reason: "files_preparing", retryAfterSeconds };
  }
  if (input.statusCode === 429) {
    return { retryable: true, reason: "rate_limited", retryAfterSeconds };
  }
  if (typeof input.statusCode === "number" && input.statusCode >= 500) {
    return { retryable: true, reason: "provider_unavailable", retryAfterSeconds };
  }
  return { retryable: false, reason: "rejected", retryAfterSeconds: null };
}

function parseRetryAfter(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}
