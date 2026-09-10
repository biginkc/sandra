import { describe, expect, it, vi } from "vitest";
import { createReadScheduler } from "./read-scheduler";

describe("request read scheduler", () => {
  it("starts lazy reads before awaiting them, bounds concurrency, and executes once", async () => {
    const read = createReadScheduler(2);
    const starts: number[] = [];
    const releases: Array<() => void> = [];
    const results = [0, 1, 2].map((id) => read(() => ({
      then<T = number, U = never>(resolve?: ((value: number) => T | PromiseLike<T>) | null, reject?: ((reason: unknown) => U | PromiseLike<U>) | null) {
        starts.push(id);
        return new Promise<void>((release) => releases.push(release)).then(() => id).then(resolve, reject);
      },
    })));
    await vi.waitFor(() => expect(starts).toEqual([0, 1]));
    releases[0]();
    await vi.waitFor(() => expect(starts).toEqual([0, 1, 2]));
    releases[1](); releases[2]();
    expect(await Promise.all(results)).toEqual([0, 1, 2]);
    expect(await results[0]).toBe(0);
    expect(starts).toEqual([0, 1, 2]);
  });

  it("releases slots on failure and keeps the original rejection observable", async () => {
    const read = createReadScheduler(1);
    const error = new Error("read failed");
    const failed = read(() => { throw error; });
    const next = read(() => "next");
    expect(await next).toBe("next");
    await expect(failed).rejects.toBe(error);
  });
});
