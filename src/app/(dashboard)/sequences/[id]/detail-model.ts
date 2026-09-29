import type { Result } from "@/lib/errors/result";

export type EnrollmentActionOutcome = { id: string; ok: boolean; message: string };

/** A bounded selection is executed one enrollment at a time so one failure cannot hide the rest. */
export async function runSelectedEnrollmentAction<T>(
  ids: string[], action: (id: string) => Promise<Result<T>>,
): Promise<EnrollmentActionOutcome[]> {
  const outcomes: EnrollmentActionOutcome[] = [];
  for (const id of [...new Set(ids)].slice(0, 200)) {
    try {
      const result = await action(id);
      outcomes.push({ id, ok: result.ok, message: result.ok ? "Done" : result.error.message });
    } catch (error) {
      outcomes.push({ id, ok: false, message: error instanceof Error ? error.message : "Action failed" });
    }
  }
  return outcomes;
}
