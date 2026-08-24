# Sandra Leads Open-in-New-Tab Convergence Ledger

## Goal

- `goal_id`: `sandra-leads-open-new-tab`
- Make each lead address on `/leads` a native browser link so a VA can right-click and open the lead detail in a new tab without breaking normal click navigation, drag-and-drop, or card controls.
- Plan source: Jarrad's 2026-08-24 request in the Codex task.
- Baseline: `origin/main` at `c7fe232ba715032b40f25eeb5f7c13c61610745f`.
- Final branch was rebased onto `origin/main` at `216bbd64cabad56f36c63f7fb2538025b431daa1` before final review.
- Authority profile: Production-aware; Jarrad explicitly requested implementation through production.
- Dependencies: none identified at baseline; re-check before PR creation and merge.

## Acceptance gates

- [ ] The lead address is a real link with an `/leads/<id>` `href`.
- [ ] Normal address click opens the same lead detail in the current tab.
- [ ] Browser right-click offers **Open Link in New Tab**, and using it leaves the board open while opening the matching detail route in a second tab.
- [ ] Dragging a card between columns still works.
- [ ] Existing card controls remain independently usable and do not trigger navigation or drag.
- [ ] Focused component tests, typecheck/unit gates, and the relevant browser regression pass.
- [ ] PR declares `Depends on: none`, is mergeable, and required checks are green.
- [ ] Parallel manual code review is clean at the final head.
- [ ] Claude returns high-confidence approval at the final head.
- [ ] The merged production deployment is healthy and real Chrome proves the behavior on `https://sandra.bmhgroupkc.com/leads`.

## Preflight

- Claude desktop: running and reachable; the front conversation was already occupied, so a clean conversation will be used.
- Claude CLI fallback: installed and authenticated; desktop remains the primary surface.
- Browser proof: Chrome-control plugin and browser client are present; real Chrome proof is required.
- Repo/provider tools: GitHub CLI authenticated; Fallow CLI present; Vercel/deployment state can be checked through GitHub/Vercel surfaces.
- Current implementation evidence: `kanban.tsx` renders the address as a `<button>` and navigates via `router.push`, so the browser has no link target for its native context menu.
- Safety: no schema, provider, secret, customer-contact, or production-data mutation is in scope.

## Iterations

### Iteration 1 - plan approval

- Claude verdict: `NEXT_STEP`, confidence `high`.
- Approved action: replace the address button with a `next/link` anchor at the same visual location; preserve the 4px PointerSensor activation constraint; keep every other interactive card control outside the anchor; consider `prefetch={false}` to avoid a prefetch per visible card.
- Required verification: assert a literal `/leads/<id>` href and no button role, prove a drag past the activation threshold does not navigate, then manually verify right-click/new-tab, ordinary click, card drag, and every nested control in real Chrome on preview and production.
- Codex adversarial evaluation: accepted. The action is minimal, testable, within scope, and does not cross a hard gate. Native context-menu proof is correctly reserved for real Chrome.

### Iteration 2 - implementation and local verification

- Implementation: the visible address is now a native Next.js link to `/leads/<id>` with prefetch disabled. Its pointer and click events remain isolated from the draggable/clickable card without cancelling the browser's default link behavior.
- Component regression: verifies the anchor and exact href, keyboard focus, modifier-click isolation, card-body navigation, and pointer isolation for the link and nested Set control.
- Browser regression: verifies ordinary and modifier-click navigation, preservation of the original board tab, matching detail content, nested Set/Cancel isolation, and persisted drag-and-drop.
- Verification: focused RTL `33/33` passed; typecheck passed; full `npm run verify` passed with `3,201` tests; focused Chrome-channel Playwright passed `3/3` (authentication setup, persisted card drag, and the full board foundation flow).
- Earlier Playwright attempts were invalidated by a different worktree resetting the shared test database. The final run was isolated and passed cleanly.
- No schema, provider configuration, environment variable, customer communication, or production-data change was introduced.
