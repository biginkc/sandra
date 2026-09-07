# Sandra Dialer — Live Coach Switch — Implementation Prompt

Prototype: `Dialer Coach Switch.dc.html` — **1a** = off (default), **1b** = on with script dropdown (opens standalone; `support.js` + `public/brand/` beside it). HTML design reference, not code to copy. Implement inside `src/components/softphone/softphone-provider.tsx` (IdleView) using the existing stack (Tailwind v4, lucide-react). Reference repo: `biginkc/sandra` @ `main` (read 2026-09-07).

## What it is
A per-rep preference row in the dialer popover (`IdleView`) that decides whether the full-screen `CoachLiveView` opens automatically when a call connects, and which script it loads. Not every outbound call needs the coach. **Default off.**

## Placement
Directly under `CallerIdControl`, above the `dialer-input`. Rendered only when `isCoachUiEnabled()` (`src/lib/coach/flags.ts`) and `callingEnabled`.

## Visual (option 1a)
Block: flex column, gap 6px, padding 8px 10px, radius 12px. Top row: flex, align center, gap 10px.
- Background: `radial-gradient(120% 140% at 50% 0%, #16203a 0%, #0c1426 45%, #070b16 100%)` (login-page palette, `login-background.tsx`).
- Border: `1.5px solid rgba(120,176,255,0.55)`.
- Glow: `0 0 0 1px rgba(60,130,255,0.16), 0 0 18px rgba(46,128,255,0.35), inset 0 1px 0 rgba(160,200,255,0.18)` (same family as `CARD_GLOW` in `login/page.tsx`).
- Text color `#f3f6fb`. The row looks identical whether on or off; only the switch knob and aria state change.

Left: 36px circular avatar, `overflow:hidden`, bg `#0c1426`, border `1.5px solid rgba(120,176,255,0.55)`, glow `0 0 12px rgba(46,128,255,0.35)`. Inside: the mascot head crop. Add `public/brand/mascot-head.svg` = `mascot.svg` with `viewBox="870 430 680 700"` (head only). `alt=""`, `aria-hidden`.

Middle (flex 1, column, gap 3px):
- Headline 13px / 800 / nowrap: **Want some help? Enable live coach.**
- Sub 11px `#a9b6cf`, single line, `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`: **Sandra listens, keeps the script on screen, and suggests what to say next.**

Right: switch button 38×20, radius 999px, `border:1.5px solid rgba(120,176,255,0.7)`, `role="switch"`, `aria-checked`, `aria-label="Enable live coach"`, `data-testid="dialer-coach-toggle"`.
- On: bg `linear-gradient(180deg, rgba(28,46,82,0.9), rgba(14,24,46,0.95))`, glow `0 0 14px rgba(46,128,255,0.45)`, knob 14px `#78b0ff` at left 18px.
- Off: bg `rgba(255,255,255,0.04)`, no glow, knob 14px `#5b6479` at left 2px.
- Knob transition 150ms ease. Focus-visible ring `rgba(46,128,255,0.5)`.

## Script dropdown (visible only when the switch is on)
Second line inside the same block, under the top row, indented 46px (avatar + gap): a single `<select>`-style trigger, flex 1, padding 4px 8px, radius 7px, border `1.5px solid rgba(120,176,255,0.7)`, bg `linear-gradient(180deg, rgba(28,46,82,0.65), rgba(14,24,46,0.7))`, 11px / 700 `#f3f6fb`. Left: script title (ellipsis). Right: version in Geist Mono 10px `#7e889c` + caret ▾. No "Script" eyebrow label; the option title itself contains the word "Script". `aria-label="Coach script"`, `data-testid="dialer-coach-script"`.
- Use the shadcn `Select` (Base UI) already in the codebase, styled to the above; options show title + version.
- Today there is exactly one script. Derive it from existing imports rather than hardcoding: add an optional `title` field to `closr-script-v0.json` (`"CLOSR Outbound Sales Script"`) and to `script-schema.ts`; version from `script.version`.
- Introduce `src/lib/coach/script-registry.ts` exporting `COACH_SCRIPTS: readonly { id: string; title: string; version: string }[]` with the single entry `id: "closr-outbound"`. This is the seam for future scripts; do not build multi-script loading now. With one script it is preselected and the trigger still renders (so reps learn where the choice lives).
- Expand/collapse 150ms height/opacity. Off row ≈ 54px; on row adds one ≈ 26px line. Nothing else in the popover moves except the natural push-down.
