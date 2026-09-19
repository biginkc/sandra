import { beforeEach, describe, expect, it, vi } from "vitest";

const { processEnrollmentTick, releaseQueuedMessage, failQueuedMessage, reportError } =
  vi.hoisted(() => ({
    processEnrollmentTick: vi.fn(),
    releaseQueuedMessage: vi.fn(),
    failQueuedMessage: vi.fn(),
    reportError: vi.fn(),
  }));

vi.mock("@/lib/sequences/tick", () => ({ processEnrollmentTick }));
vi.mock("@/lib/messaging/send", () => ({
  failQueuedMessage,
  PROVIDER_PENDING_STALE_MS: 60_000,
  releaseQueuedMessage,
}));
vi.mock("@/lib/errors/report", () => ({ reportError }));

import { runSequenceTick } from "./handlers";

function resultBuilder(
  data: unknown,
  error: unknown = null,
  onCall?: (method: string, args: unknown[]) => void,
) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "lte", "or", "order", "limit", "update"]) {
    builder[method] = (...args: unknown[]) => {
      onCall?.(method, args);
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => unknown) =>
    resolve({ data, error });
  builder.maybeSingle = () => Promise.resolve({ data, error });
  return builder;
}

function makeClient(due: unknown[]) {
  return {
    from: vi.fn((table: string) => {
      if (table === "sequence_enrollments") return resultBuilder(due);
      return resultBuilder([]);
    }),
  } as never;
}

function makePagedClient(
  pages: unknown[][],
  onEnrollmentQuery: (pageIndex: number, method: string, args: unknown[]) => void,
) {
  let enrollmentQuery = 0;
  return {
    from: vi.fn((table: string) => {
      if (table === "sequence_enrollments") {
        const pageIndex = enrollmentQuery++;
        return resultBuilder(
          pages[Math.min(pageIndex, pages.length - 1)] ?? [],
          null,
          (method, args) => onEnrollmentQuery(pageIndex, method, args),
        );
      }
      return resultBuilder([]);
    }),
  } as never;
}

describe("runSequenceTick enrollment isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseQueuedMessage.mockReset();
    failQueuedMessage.mockReset();
    releaseQueuedMessage.mockResolvedValue({ status: "sent" });
  });

  it("counts a thrown enrollment as failed and continues to the next due row", async () => {
    const due = [
      { id: "enrollment-1" },
      { id: "enrollment-2" },
    ];
    processEnrollmentTick
      .mockRejectedValueOnce(new Error("template rendering failed"))
      .mockResolvedValueOnce({
        status: "sent",
        enrollmentId: "enrollment-2",
        stepIndex: 0,
        messageId: "message-2",
      });

    const summary = await runSequenceTick(makeClient(due), { budgetMs: 10_000 });

    expect(summary.processed).toBe(2);
    expect(summary.outcomes).toEqual({ failed: 1, sent: 1 });
    expect(processEnrollmentTick).toHaveBeenNthCalledWith(1, expect.anything(), due[0]);
    expect(processEnrollmentTick).toHaveBeenNthCalledWith(2, expect.anything(), due[1]);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: { enrollmentId: "enrollment-1" },
      }),
    );
  });

  it("looks past a full retained-claim page with stable keyset ordering", async () => {
    const dueAt = "2026-09-17T12:00:00.000Z";
    const retained = Array.from({ length: 100 }, (_, index) => ({
      id: `retained-${String(index).padStart(3, "0")}`,
      next_run_at: dueAt,
    }));
    const independent = { id: "independent", next_run_at: dueAt };
    const enrollmentQueries: Array<{ page: number; method: string; args: unknown[] }> = [];
    processEnrollmentTick.mockImplementation(async (_client, enrollment) =>
      enrollment.id === independent.id
        ? { status: "sent", enrollmentId: enrollment.id, stepIndex: 0, messageId: "message-101" }
        : { status: "skipped_already_claimed", enrollmentId: enrollment.id },
    );

    const summary = await runSequenceTick(
      makePagedClient([retained, [independent]], (page, method, args) => {
        enrollmentQueries.push({ page, method, args });
      }),
      { budgetMs: 10_000 },
    );

    expect(summary.processed).toBe(101);
    expect(summary.outcomes).toEqual({ skipped_already_claimed: 100, sent: 1 });
    expect(enrollmentQueries.filter(({ method }) => method === "order")).toHaveLength(4);
    expect(enrollmentQueries.filter(({ method }) => method === "or")).toEqual([
      expect.objectContaining({
        page: 1,
        args: [expect.stringContaining("next_run_at.gt.2026-09-17T12:00:00.000Z")],
      }),
    ]);
  });

  it("keeps ordinary due work within one batch when the page has actionable work", async () => {
    const due = Array.from({ length: 100 }, (_, index) => ({
      id: `due-${index}`,
      next_run_at: "2026-09-17T12:00:00.000Z",
    }));
    const enrollmentQueries: number[] = [];
    processEnrollmentTick.mockImplementation(async (_client, enrollment) =>
      enrollment.id === due[0].id
        ? { status: "sent", enrollmentId: enrollment.id, stepIndex: 0, messageId: "message-1" }
        : { status: "skipped_already_claimed", enrollmentId: enrollment.id },
    );

    const summary = await runSequenceTick(
      makePagedClient([due], (page, method) => {
        if (method === "select") enrollmentQueries.push(page);
      }),
      { budgetMs: 10_000 },
    );

    expect(summary.processed).toBe(100);
    expect(enrollmentQueries).toEqual([0]);
    expect(summary.outcomes).toEqual({ sent: 1, skipped_already_claimed: 99 });
  });
});
