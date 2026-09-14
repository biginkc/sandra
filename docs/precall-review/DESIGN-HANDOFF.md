# Implementation prompt — dialer pre-call setup panel

Repo: `biginkc/sandra` (main) · Next.js 16, Tailwind v4, shadcn/base-ui
Design artifact: `Sandra Dialer Precall Setup.dc.html` (open in a browser; turn 2 at top is the shipping direction, turn 1 below is the field/state reference)

## What to build

An expandable **pre-call setup panel** in the softphone dialer popover. It appears directly beneath the live-coach block when the rep switches "Enable live coach" ON, and disappears when they switch it OFF. It exists only before the call — the in-call coach view is untouched.

Purpose: reps fill in missing script details and pick script branches before dialing, so Live Coach reads with no empty placeholders (today the script shows `missing` chips mid-call).

## Where it goes

- `src/components/softphone/softphone-provider.tsx` — the dialer popover (`data-testid="softphone-popover"`, `w-[min(480px,calc(100vw-24px))]`). The coach block is the `Collapsible.Root` around line 1076; the panel renders **after** that block and **before** the contact/number input (line ~1064), so the caller-ID selector above and the input → keypad → Call button below keep their order and behavior.
- Extract the panel into `src/components/softphone/precall-setup-panel.tsx`; keep provider changes to mounting + state.
- Reuse `PhoneKeypad` from `phone-keypad.tsx` untouched.

## Non-negotiables

- **Do not change existing calling controls.** Call button stays `bg-[#111827]` with its existing label (`Call (816) 555-0148` / `Call`), same disabled rules (`!manualReady`, `!callingEnabled`, `!callerIdReady`). Backspace, keypad, recents, caller-ID selector, close button: unchanged.
- **Never block the call.** No validation gate. Missing values degrade to a gap in the script, never a blocked dial.
- No grading, objection cards, new script branches, or script-writing tools.

## Layout (option 2b in the design — accordion)

Panel card: `rounded-[10px] border border-[#e5e1df]`, header `bg-[#f5f5f4]` with `border-b`, title "CALL SETUP" (`text-[12px] font-extrabold uppercase tracking-[0.08em] text-[#57534e]`), a needed-count pill, and Collapse.

Four groups, **one open at a time** (base-ui `Accordion`, single). Each closed row is 40px: state dot + group name + one-line summary (truncate) + chevron.

| Group | Closed-row state |
| --- | --- |
| Call basics | green dot `#16a34a` + "Darlene Whitfield · 815 Washington St · 1962 · WF-2026-04188", or amber dot `#f59e0b` + "N needed" pill |
| Seller's situation | same rule |
| Offer details | grey dot `#d6d1ce` + "Not known yet — Sandra asks on the call" (never amber) |
| Script branches | green dot + "Cold call · Tenant-occupied · Homeowner questions · N tentative" |

On open, Sandra expands the first group that needs something. Completing a group advances to the next. Total popover height stays ~620px; the panel body never scrolls. (Option 2a — a 280px scrolling body with a pinned header — is the fallback if the accordion proves fiddly; it's drawn in the design for reference.)

Collapsed panel (all groups closed via Collapse) = a two-line receipt card: green dot, "Call details ready", line 1 who/address/opener/file number, line 2 what's still open, plus an Edit link. Stays collapsed until the rep changes homeowner.

## Fields

Field shell: `h-[34px] px-2.5 rounded-[10px] border border-[#e5e1df] bg-[#fafaf9] text-[13px] font-semibold`.
Label: `text-[10px] font-bold uppercase tracking-[0.07em] text-[#78716c] mb-1`.

**Call basics** (2-col grid, address full width): homeowner's name, rep's name, property address, rep's callback number, assistant's name (default `"Mel"`), year built, file number.

**Seller's situation**: reason for selling; desired outcome ("What selling helps her do").

**Offer details**: offer amount, net proceeds, closing date.

Prefill from the selected lead/property and the signed-in rep (`profiles`, `properties`, `leads`). Everything except file number is editable.

### Missing vs unknown — keep these visually distinct

- **Missing call basic / situation field**: `border-dashed border-[#f59e0b] bg-[#fffbeb]`, placeholder text in `#78350f` that says what to do ("Add the number to read out", "Not on the property record"), label suffixed `· needed` in `#78350f`. Group row shows an amber dot + "N needed" pill (`bg-[#fffbeb] border-[#fde68a] text-[#78350f]`). This is the app's existing warning treatment ("Calling not yet enabled" strip) — never red, never blocking.
- **Offer detail not yet known**: `border-dashed border-[#d6d1ce] bg-white text-[12px] text-[#78716c]` reading "Not known yet". Not counted in the needed count. Group hint: "Leave these unknown — Sandra asks for them when you reach the offer."

### File number

Read-only, `bg-[#f5f5f4]`, mono `text-[12.5px] text-[#57534e]`, `AUTO` tag on the right. Generated server-side from rep + property; the rep is never asked to type or invent one.
- Loading: pulsing `#e5e1df` bar inside the field shell (same for any prefilled field still loading — never show an empty input that reads as "missing").
- Unavailable: dashed `#d6d1ce` box, "Not available yet" + "Sandra creates it once the property record loads. You'll never need to type one." + a pill Retry button, mirroring the caller-ID error/retry pattern at `softphone-provider.tsx:1115`.

## Script branch dropdowns

`Select` from `src/components/ui/select.tsx`, trigger overridden to the dialer's `h-[34px] rounded-[10px] border-[#e5e1df]` (the dialer overrides the default radii throughout). Two-column grid.

| Field label | Options |
| --- | --- |
| How you're reaching her | Cold call · FSBO · SMS reply · Driving for dollars — **no "All openers"** |
| Who's living there | Unknown · Owner-occupied · Tenant-occupied · Vacant |
| Questions to ask | Homeowner · Investor · Vacant property |
| Her motivation | Clear motivation, no urgency · Clear motivation with urgency · No clear motivation |
| How the offer lands | Good news · Bad news · Bad news — below mortgage · Price too low |
| How you close | If far apart — program pivot · They accept |

- Prefill from context where known (lead source → opener; occupancy from the property record; discovery from lead type). Unset later-stage branches show placeholder text "Choose after discovery" / "Choose on the call" in `#78716c`.
- Once chosen, later-stage branches carry a `tentative` chip (`text-[9px] bg-[#f5f5f4] rounded-full px-1.5`).
- Footer line: "Choosing a branch only sets where the script opens. Nothing is skipped, and the call starts when you press Call."

## Handoff into Live Coach

On Call, pass the setup values with the call payload so the coach script renders them instead of `missing` chips: homeowner name, rep name, address, callback number, assistant name, year built, file number, reason, desired outcome, offer/net/closing when known, and the branch selections (opener/occupancy/discovery/motivation/offer outcome/closing path) as the script's initial branch state. Anything still unknown renders as the script's existing gap treatment. Branch choices remain changeable in the live script — the pre-call picks are only the starting point.

## Persistence

Draft the setup per lead (`localStorage` keyed by property/lead id is fine for v1, or a `call_setup_drafts` row if you want it cross-device) so a rep who closes the dialer and reopens it doesn't retype. Clear on disposition.

## Tests

Extend `src/components/softphone/softphone-provider.test.tsx`:
- toggling `Enable live coach` mounts/unmounts the panel;
- Call stays enabled with basics missing;
- the file number field is read-only and shows the unavailable + Retry state;
- opener options exclude "All openers";
- branch selections reach the call payload.
E2E: `e2e/synthetic/dialer-coach-switch.spec.ts` — setup values arrive in the coach script with no `missing` chips.
