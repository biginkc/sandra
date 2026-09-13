/** Retry only database receipt transactions known to have aborted.
 * The closure must not call a provider or repeat any earlier send step.
 * Thrown/network failures are ambiguous and propagate without retry.
 */
export async function retryReceiptTransaction<T extends { error: { code?: string } | null }>(
  write: () => PromiseLike<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const result = await write();
    if (attempt >= 2 || !result.error ||
        (result.error.code !== "40P01" && result.error.code !== "40001")) {
      return result;
    }
    const delay = 25 * 2 ** attempt + Math.floor(Math.random() * 25);
    await new Promise<void>(resolve => setTimeout(resolve, delay));
  }
}
