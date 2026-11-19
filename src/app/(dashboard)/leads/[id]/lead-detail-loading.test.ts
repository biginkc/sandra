import { describe, expect, it } from "vitest";

import { loadAfterReadAcknowledgement } from "./lead-detail-loading";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("loadAfterReadAcknowledgement", () => {
  it("starts independent work together and waits for acknowledgement before the snapshot", async () => {
    const independentA = deferred<string>();
    const independentB = deferred<string>();
    const acknowledgement = deferred<{ ok: true }>();
    const events: string[] = [];

    // Model Supabase's lazy query builder: the combined read starts only when
    // its thenable is assimilated by the orchestration helper.
    const independent: PromiseLike<string[]> = {
      then<TResult1 = string[], TResult2 = never>(
        resolve?:
          | ((value: string[]) => TResult1 | PromiseLike<TResult1>)
          | null,
        reject?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ): PromiseLike<TResult1 | TResult2> {
        events.push("independent-batch-started");
        return Promise.all([
          independentA.promise.then((value) => {
            events.push(`independent:${value}`);
            return value;
          }),
          independentB.promise.then((value) => {
            events.push(`independent:${value}`);
            return value;
          }),
        ]).then(resolve, reject);
      },
    };
    const pending = loadAfterReadAcknowledgement(
      independent,
      () =>
        acknowledgement.promise.then((value) => {
          events.push("acknowledged");
          return value;
        }),
      () => {
        events.push("snapshot-started");
        return Promise.resolve("messages");
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["independent-batch-started"]);

    independentA.resolve("a");
    independentB.resolve("b");
    await Promise.resolve();
    expect(events).toEqual([
      "independent-batch-started",
      "independent:a",
      "independent:b",
    ]);
    expect(events).not.toContain("snapshot-started");

    acknowledgement.resolve({ ok: true });
    await expect(pending).resolves.toEqual({
      independent: ["a", "b"],
      acknowledgement: { ok: true },
      snapshot: "messages",
    });
    expect(events).toEqual([
      "independent-batch-started",
      "independent:a",
      "independent:b",
      "acknowledged",
      "snapshot-started",
    ]);
  });

  it("observes an independent rejection while preserving acknowledgement ordering", async () => {
    const acknowledgement = deferred<{ ok: false }>();
    let snapshotStarted = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const independent = Promise.reject(new Error("timeline unavailable"));

    try {
      const pending = loadAfterReadAcknowledgement(
        independent,
        () => acknowledgement.promise,
        () => {
          snapshotStarted = true;
          return Promise.resolve("messages");
        },
      );

      // Let the rejection reach the host while acknowledgement remains
      // pending. A broken observer would trigger unhandledRejection here.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(snapshotStarted).toBe(false);
      acknowledgement.resolve({ ok: false });
      await expect(pending).rejects.toThrow("timeline unavailable");
      expect(snapshotStarted).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
