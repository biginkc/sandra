# PR 669 — Fix round 1

- The flag-off synthetic audio harness now explicitly compiles the V2 flag as
  disabled. Its browser bundle no longer dereferences an undefined public
  environment variable before mounting the coach; all 13 audio cases cover
  this mount path.
- The shared navigator is lazy-loaded, the V2 header phase scroller is absent,
  and the transcript grid item can shrink inside its fixed desktop track.
- Navigator state is React state and recommendation requests use its active
  section, branch selection, and overrides in V2. The component regression
  advances to `introduction.qualification-frame` before requesting guidance.
- V2 contrast coverage measures real compiled CSS in both themes for script
  lines, navigator rail/tab labels, both ref labels, counter, Back, and Next;
  all measurements are at least 4.5:1. The V2 disabled Back control keeps its
  readable muted color without package opacity.
- Removed obsolete root `--coach-*` aliases. V2 `--coach-amber*` now derives
  from Sandra's `--alert-warning` token so reconnect status remains a warning.
