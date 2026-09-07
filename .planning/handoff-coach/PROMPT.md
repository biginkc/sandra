# Sandra Live Call Coach — Visual Redesign Prompt

Prototype: `Coach Live View - Steel Blue.dc.html` (opens standalone in a browser; `support.js` beside it). It is an **HTML design reference**, not code to copy. Recreate it inside `src/components/coach/coach-live-view.tsx` and its children using the existing stack (Next.js, Tailwind v4, shadcn/Base UI, lucide-react, `sandra-tokens.css`).

Reference repo: `biginkc/sandra` @ `main` (read 2026-09-07). Parity ledger: `PARITY.md`.

## Scope contract
This is a **restyle + re-layout** of the existing `CoachLiveView`. Every element in the prototype maps to a component or state that already exists in `coach-live-view.tsx`, `use-coach-session.ts`, `script-block.ts`, and `recommendation-client.ts` — see PARITY.md. No new events, no new server actions, no script/manifest changes, no change to `event-reducer.ts`.

The coach UI stays behind `NEXT_PUBLIC_COACH_UI_ENABLED=1` (`src/lib/coach/flags.ts`).

**Explicitly out of scope** (the prototype shows them as a proposal; they were removed upstream in the manual-nav rework and are NOT to be reintroduced without a separate decision): the amber **Objection card** with Acknowledge/Disarm/Overcome steps and progress bar; the **gate chips** ("No concerns ✓", "Probes 9/7 ✓"). Omit these; leave the coach rail's `margin-top:auto` slot empty.

## Fidelity
High-fidelity. Match colors, type scale, spacing, and radii below. Keep all existing `data-testid` attributes and aria labels so `coach-live-view.test.tsx` and `coach-live-contrast.spec.ts` keep passing (update contrast fixtures to the new palette).

## Palette (dark surface — replaces `bg-background` / `bg-card` / `bg-muted` in this view only)
- Field (script column bg): `#1f2a3c`
- Rails, top bar, dock bg: `#151d2b`
- Card / seller bubble: `#2a3649`
- Rep bubble / progress track: `#354258`
- Hairline borders: `#465569`
- Body text: `#ffffff`
- Secondary text: `#d1d8e3`
- Muted labels: `#a3aebf`
- Sky accent (tokens, phase ticks, Live pill, Rep label, Up-next label): `#7dd3fc`
- Amber (seller label, hold pill border): `#fcd34d`; amber text `#fde68a`
- Primary action (Next, selected path chip): bg `#ffffff`, text `#1f2a3c`
- Hang up: `#dc2626`
All secondary tones are opaque and ≥ 4.5:1 on their surface — do not use alpha-muted text.

Implement as scoped CSS variables on the dialog root (e.g. `[data-testid="coach-live-view"]`) overriding `--background`, `--card`, `--muted`, `--border`, `--foreground`, `--muted-foreground`, `--primary`, `--primary-foreground`) so shadcn `Button`/`Badge` pick them up without per-element class rewrites.

## Type
- Body: Inter (already the app font). Mono: Geist Mono (already loaded via `sandra-tokens.css`).
- Script "say" lines: 27px / 1.5 / weight 500. Resolved tokens inside: weight 800, `#7dd3fc`.
- Script "note" lines: 13px italic `#d1d8e3`.
- Section eyebrow (`Phase · Section title`): 11px / 900 / 0.16em tracking / uppercase / `#a3aebf`.
- Up-next label: 11px / 900 / 0.14em / uppercase / `#7dd3fc`; up-next body 17px / 1.5 / `#d1d8e3`.
- Rail headings ("Transcript", "Coach"): 11px / 800 / 0.12em / uppercase / `#a3aebf`.
- Transcript speaker labels: 10px / 800 / 0.1em / uppercase — Rep `#7dd3fc`, Seller `#fcd34d`. Transcript text 15px / 1.5 / white.
- Timer, file number, section counter: Geist Mono. Timer 16px/600; file number 12px `#d1d8e3`; counter 12px `#a3aebf`.

## Layout (1440 × 900 reference; view is full-screen dialog `h-dvh w-screen`)
1. **Top bar** — 60px, `#151d2b`, bottom hairline. Three zones:
   - Left (min 260px): callName 15px/800 + file number (mono).
   - Center: phase rail as a connected stepper — each phase a pill (11px/700/0.06em uppercase). Completed: `#7dd3fc` text with a 16px filled `#7dd3fc` circle containing ✓; connectors 20×2px `#7dd3fc`. Current: white pill bg, `#1f2a3c` text, weight 800. Upcoming: `#a3aebf` text, no tick, connector `#465569`. Keep `RAIL_LABEL` shorthand and existing aria-labels / `phase-rail-*` testids; still clickable → `goToPhase`.
   - Right (min 260px, right-aligned): `HoldTimer` restyled as outlined amber pill ("Hold 2:41"); Live pill outlined `#7dd3fc` with 7px dot; call timer mono 16px. Keep connecting/ringing/degraded badges in the same row, same tokens.
   - Amber reconnect/reconnect-gap banners below the bar stay as-is functionally; restyle to `#2a3649` bg, `#fcd34d` border, `#fde68a` text.
2. **Body grid** — `grid-template-columns: 380px minmax(0,1fr) 320px` at ≥ xl. Below xl keep the current stacked flex order (transcript / script / recommendations).
3. **Transcript rail (left)** — `#151d2b`, right hairline. Header row: "Transcript" + "● listening" (11px/700 `#7dd3fc`) when `!degraded`. Lines render as chat bubbles, **top-down, newest at bottom**, gap 12px, max-width 90%: Rep right-aligned, `#354258`, radius `14px 14px 4px 14px`; Seller left, `#2a3649`, radius `14px 14px 14px 4px`; padding 10×13. Non-final line: transparent bg, `1px dashed #465569`, italic `#d1d8e3`, label suffix " · speaking…". Keep `TranscriptFeed`'s scroll-pinning, 200-line cap, and empty-state copy.
4. **Script column (center)** — `#1f2a3c`, padding `28px 48px 0`, inner max-width 820px centered, flex column filling height:
   - Eyebrow: `{phaseName} · {block.title}`.
   - Section path options (`branchOptions.length > 1`): 4-up grid, gap 8, 12px radius; selected = white bg / `#1f2a3c` text / 2px white border / 800; others transparent / `1px #465569` / `#d1d8e3` / 700. 13px. Same `section-path-*` testids and `role=tab`.
   - Branch lines: stack, gap 20px. Drop the "Current script" card chrome, left accent border, Purpose line, and per-branch tag/auto badge header; keep tone chip (restyle: `#fcd34d` bg, `#151d2b` text, 11px/700, pill) shown above the first line when present, and variant tabs (same style as path chips, small) when `variantOptions.length > 1`. Token chips: resolved → bold sky inline text; placeholder → dashed `#465569` pill "missing"; entry chip → dashed `#7dd3fc` pill `+ label` / resolved `#7dd3fc` outlined pill. `holdAfter` → centered 11px uppercase on `#2a3649`.
   - Up-next block: `margin-top:28px`, top hairline, padding-top 18px. Label `Up next · {nextBlock.phaseName} — {nextBlock.title}`; body = `selectSpokenLine(nextBlock.branches[0])` text in curly quotes, 2-line clamp.
   - Nav row: `margin-top:auto`, top hairline, padding `16px 0 20px`. Back = outlined ghost (12×20, 12px radius, 14px/700 `#d1d8e3`), center = `Section {i} of {n}` (mono, from `COACH_SECTIONS` index of `activeSectionId`), Next = white primary 14×36, 16px/800. Keep `coach-back` / `coach-next` testids and disabled states. Remove the sticky/backdrop-blur wrapper (column already fills height).
   - Context-error and degraded notes stay above the eyebrow, restyled to the amber card tokens above.
5. **Coach rail (right)** — `#151d2b`, left hairline, padding 16, gap 12. Heading "Coach". Then, in order: automatic recommendations as cards (`#2a3649`, `1px #465569`, 14px radius, padding 12×14; eyebrow "Consider saying" 10px/800/0.1em `#a3aebf`; body 13px/1.5 white); "Follow-up Questions" full-width outlined button (11px padding, 10px radius, 13px/700 white); follow-up list as the same cards; loading / limit / error / "Available after the homeowner has spoken" lines 12px `#a3aebf`. Drop the "Helpful ways to go deeper" h2 and the intro paragraph — show the intro paragraph only when there are zero recommendations and zero follow-ups.
6. **Call dock (bottom)** — `#151d2b`, top hairline, padding 12×24. Left: "✕ Collapse" ghost (9×16, 10px radius, 13px/700 `#d1d8e3`) — callName moves to the top bar, remove it here. Right: Mute / Keypad / Hold as outlined ghosts (10×20, 10px radius, 13px/700 white; pressed state = white bg `#1f2a3c` text), Hang up `#dc2626` 13px/800. `PhoneKeypad` renders above the row when open, unchanged.

## Responsive
≥1280 (xl): grid above. <1280: current stacked order; transcript rail fixed 192px tall, script min-height 28rem, recommendations min 16rem — unchanged logic, new tokens. Mobile (375) design not yet provided; do not invent one.

## Verification
- All testids in PARITY.md still present; `coach-live-view.test.tsx` green.
- Contrast spec updated: every text/bg pair listed in Palette ≥ 4.5:1 (11px labels included).
- Keyboard: Esc collapses (unless in entry editor), DTMF guard unchanged, focus returns to `header-dialer-button`.
- No objection card, no gate chips rendered.
