# Parity ledger — Coach Live View restyle

Source: `src/components/coach/coach-live-view.tsx` @ main (2026-09-07). Every shipped element → where it lives in the prototype.

| Shipped element (testid) | Prototype location | Change |
|---|---|---|
| Dialog root `coach-live-view`, Esc/collapse, finalFocus | Full-screen board | Tokens only |
| `coach-status-strip`: `coach-current-phase` badge | Removed — phase is shown by the stepper's current pill | Drop badge (keep testid on current pill's parent if tests need it) |
| `coach-file-number` | Top bar left, mono | Restyle |
| `coach-call-timer` | Top bar right, mono 16px | Restyle |
| `call-status-pill` (Connecting…/Ringing…) | Top bar right | Restyle, outlined `#a3aebf` |
| `coach-live-pill` | Top bar right, sky outlined | Restyle |
| `HoldTimer` | Top bar right, amber outlined pill | Restyle |
| `coach-connecting-pill` (Transcript connecting…) | Top bar right; also hides "listening" in rail | Restyle |
| `coach-phase-scroller`, `phase-rail-*` | Top bar center stepper | Restyle (ticks + connectors) |
| `coach-audio-reconnect-warning`, `coach-reconnect-audio`, `coach-warning-hangup` | Banner under top bar | Amber dark tokens |
| `coach-reconnect-gap`, `dismiss-reconnect-gap` | Banner under top bar | Amber dark tokens |
| `coach-transcript`, `transcript-line`, `transcript-speaker-label`, `data-final` | Left rail bubbles | Restyle; bubble per line |
| Transcript empty state copy | Left rail | Unchanged copy |
| `coach-script-panel` | Center column | Restyle |
| `coach-context-error`, `coach-context-retry` | Above eyebrow | Restyle |
| `coach-degraded-note` | Above eyebrow | Restyle |
| `current-script-card` | Center column (no card chrome) | Keep testid on wrapper |
| `current-section-title` | Eyebrow `{phase} · {title}` | Restyle |
| `current-phase-purpose` | **Removed from view** | Keep in DOM `sr-only` if tests assert it |
| `section-path-options`, `section-path-*` | 4-up chip grid | Restyle |
| `current-section-script`, `script-branch` | Line stack | Drop tag/auto header; keep testids |
| `variant-*` tabs | Small chips above lines | Restyle |
| `tone-chip` | Amber solid pill | Restyle |
| `token-resolved` | Bold sky inline | Restyle |
| `token-placeholder` | Dashed pill "missing" | Restyle |
| `entry-chip-*`, `entry-input-*`, `data-coach-entry-editor` | Sky outlined pill / inline input | Restyle; behavior unchanged |
| `holdAfter` strip | Centered uppercase strip | Restyle |
| `next-section-preview`, `next-section-preview-body` | Up-next block | Restyle; label adds title |
| `section-navigation`, `coach-back`, `coach-next` | Nav row + new "Section i of n" counter | Restyle; counter is display-only from existing section index |
| `coach-recommendations` | Right rail | Restyle |
| "Helpful ways to go deeper" h2 + intro `<p>` | Intro shown only in empty state | Reduce |
| `automatic-recommendations` list | Cards | Restyle |
| `follow-up-questions` button | Full-width outlined | Restyle |
| "Available after the homeowner has spoken." | 12px muted | Unchanged |
| `follow-up-question-options` | Cards | Restyle |
| `automatic-recommendations-loading`, limit copy, `recommendation-error` | 12px muted lines | Unchanged copy |
| `coach-call-dock-row`, `coach-collapse` | Bottom dock left | Restyle; callName removed here (moved to top bar) |
| `coach-call-controls`: `coach-mute`, `coach-keypad-toggle`, `coach-hold`, `coach-hangup` | Bottom dock right | Restyle |
| `PhoneKeypad` | Above dock row when open | Unchanged |

## Intentionally removed from shipped view
- `coach-current-phase` badge (redundant with stepper).
- `current-phase-purpose` text (available via tooltip if desired; not in prototype).
- Branch tag label + "auto" badge per branch.
- callName in dock (relocated to top bar).

## In prototype but NOT to implement
- Objection card (amber, Acknowledge/Disarm/Overcome, progress bar).
- Gate chips ("No concerns ✓", "Probes 9/7 ✓").
These depend on objection/probe/gate state that `use-coach-session.ts` no longer exposes to the view. Pending product decision.
