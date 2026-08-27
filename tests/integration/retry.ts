export type RetryOptions = {
  attempts?: number;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

const defaultSleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/**
 * Retry a shared-test setup operation after transient hosted-service failures.
 * The operation must be idempotent (reset_tenant_tables and the coach migration
 * replay both are). Every failed attempt completes before the next begins, so a
 * retry never overlaps the operation it is recovering.
 */
export async function retryTestSetup(
  operation: () => Promise<void>,
  { attempts = 3, delayMs = 1_000, sleep = defaultSleep }: RetryOptions = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}
