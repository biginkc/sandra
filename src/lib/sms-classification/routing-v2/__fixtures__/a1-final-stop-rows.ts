/**
 * Review A-1 (2026-10-31): v7 replay rows with a confident asked_stop (≥0.70) beside a
 * legal/hostile answer in the Haiku band. "A Jev stop ≥70% is final" (Jarrad 2026-10-30), so
 * these are Jev stops and Haiku is never asked. Used by the replay gates only.
 */
export const A1_FINAL_STOP_ROWS: ReadonlySet<number> = new Set([121, 132, 377, 1156, 1190, 1573]);
