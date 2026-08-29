import { describe, expect, it, vi } from "vitest";

import { retryTestSetup } from "../../../tests/integration/retry";

describe("coach authorization CI setup retry", () => {
  it("retries a transient reset failure and remains safe to rerun", async () => {
    const reset = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(undefined);
    const sleep = vi.fn(async () => undefined);

    await expect(retryTestSetup(reset, { attempts: 3, delayMs: 25, sleep })).resolves.toBeUndefined();
    await expect(retryTestSetup(reset, { attempts: 3, delayMs: 25, sleep })).resolves.toBeUndefined();

    expect(reset).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("fails loudly after the bounded retry budget instead of skipping authorization assertions", async () => {
    const reset = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const sleep = vi.fn(async () => undefined);

    await expect(retryTestSetup(reset, { attempts: 3, delayMs: 25, sleep })).rejects.toThrow("fetch failed");
    expect(reset).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
