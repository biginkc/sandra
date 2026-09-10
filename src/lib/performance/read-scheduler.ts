/** Per-request concurrency bound for independent reads. Tasks start eagerly;
 * consumers can await results later without re-executing a lazy DB builder. */
export function createReadScheduler(concurrency = 6) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Read concurrency must be a positive integer.");
  }
  let active = 0;
  const queue: Array<() => void> = [];
  const drain = () => {
    while (active < concurrency && queue.length) queue.shift()!();
  };
  return function read<T>(task: () => T | PromiseLike<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          active--;
          drain();
        });
      });
      drain();
    });
    // The page can fail or redirect before it consumes a scheduled read.
    // Mark that rejection handled, while preserving rejection for its awaiter.
    void result.catch(() => undefined);
    return result;
  };
}
