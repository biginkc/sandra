export type ImportSideEffectState =
  | "not_requested"
  | "pending"
  | "completed"
  | "failed";

export type ImportSideEffectResult = {
  status: ImportSideEffectState;
  message?: string;
  [key: string]: unknown;
};

export type ImportSideEffects = Record<string, ImportSideEffectResult>;

/**
 * A CSV import is only complete when every row and every requested follow-up
 * operation has reached a verified successful terminal state.
 */
export function importTerminalStatus(args: {
  totalRows: number;
  processedRows: number;
  succeeded: number;
  failed: number;
  sideEffects?: ImportSideEffects;
}): "completed" | "partially_completed" | "failed" {
  const effects = Object.values(args.sideEffects ?? {});
  const hasUnfinishedEffect = effects.some(
    (effect) => effect.status === "pending" || effect.status === "failed",
  );

  if (
    args.totalRows > 0 &&
    args.processedRows === args.totalRows &&
    args.failed === 0 &&
    !hasUnfinishedEffect
  ) {
    return "completed";
  }

  if (args.succeeded > 0) return "partially_completed";
  return "failed";
}
