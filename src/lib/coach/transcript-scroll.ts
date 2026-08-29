/** How close to the bottom (in px of unscrolled content) still counts as
 * "at the bottom" for auto-scroll purposes. */
export const TRANSCRIPT_AUTOSCROLL_THRESHOLD_PX = 48;

/** Pure predicate behind the transcript feed's autoscroll: only follow new
 * lines when the rep was already at (or near) the bottom, so scrolling up
 * to reread something isn't yanked back down by the next line arriving. */
export function isNearTranscriptBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx: number = TRANSCRIPT_AUTOSCROLL_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}
