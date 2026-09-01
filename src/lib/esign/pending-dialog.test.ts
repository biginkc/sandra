import { describe, expect, it, vi } from "vitest";

import { cancelPendingDialogClose } from "./pending-dialog";

describe("cancelPendingDialogClose", () => {
  it("cancels Base UI before rejecting a pending close request", () => {
    const cancel = vi.fn();

    expect(cancelPendingDialogClose(false, true, { cancel })).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    [true, true],
    [true, false],
    [false, false],
  ] as const)(
    "does not cancel when nextOpen=%s and pending=%s",
    (nextOpen, pending) => {
      const cancel = vi.fn();

      expect(cancelPendingDialogClose(nextOpen, pending, { cancel })).toBe(
        false,
      );
      expect(cancel).not.toHaveBeenCalled();
    },
  );
});
