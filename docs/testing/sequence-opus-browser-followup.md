# Opus 5 Browser harness follow-up

Session: `4b173f46-0d2d-4a10-af8f-fc696e04baec`. Model usage verifies `claude-opus-5`. Scope is the bounded test/harness review; not deployment or final readiness approval.

# CHANGES REQUIRED

Two blockers, both with concrete evidence from the material under review. The two corrections I *can* verify end-to-end (`response.finished()` and `waitUntil: "domcontentloaded"`) are sound and well-targeted — details below.

---

## B1 — The `Step N` assertion is ambiguous with the dialog title, so "expect Step 2" does not verify what it claims

`editor.tsx`, `AddStepButton`:

```tsx
<DialogTitle>Add step {nextIndex + 1}</DialogTitle>
```

shadcn's `DialogTitle` is `DialogPrimitive.Title`, which Radix renders as `<h2>` → `role=heading`. Playwright's `getByRole(role, { name })` with a string is **case-insensitive substring** matching by default. Therefore:

- second add step: `nextIndex === 1` → accessible name `"Add step 2"` → matches `getByRole("heading", { name: "Step 2" })`
- first add step (pre-existing, in `addSmsStep`): name `"Add step 1"` → matches `{ name: "Step 1" }`

Now consider the ordering the patch itself establishes. `onSave` closes the dialog only inside the transition, after `await callAction(...)` resolves — i.e. after the client deserializes the action's return value, which for a streamed RSC action response happens **before** the response body completes. `clickAndAwaitServerAction` returns at `response.finished()`, which is the end of the body stream. So the dialog is *usually* already closed at assertion time — but "usually" is doing the work. If React has not yet committed the close, the only heading matchable is the dialog's own title (Radix `aria-hidden`s the page body while a modal is open, so the real `Step 2` heading is not in the a11y tree at that moment), `toBeVisible()` succeeds on its first poll, and `addStatusStep(page, 2)` has asserted nothing about the step. A false pass here silently restores the exact class of early-exit the patch exists to eliminate.

Fix is one option flag, in both helpers:

```ts
await expect(
  page.getByRole("heading", { name: `Step ${expectedStepNumber}`, exact: true }),
).toBeVisible();
```

`"Add step 2" !== "Step 2"`, so `exact: true` removes the collision entirely. Same for `addSmsStep`'s hardcoded `"Step 1"` — the patch already touches that function, and it carries the identical `"Add step 1"` collision.

## B2 — `waitForLoginFormHydration` selectors are unverifiable from the submitted material and gate 4 of 6 tests

```js
document.querySelector('input[aria-label="Email"]')
document.querySelector('input[aria-label="Password"]')
document.querySelector('button[type="submit"]')
```

The login page source is not in the review set, and there are three independent ways these `querySelector` calls resolve to `null` while the Playwright locators they're meant to mirror keep working:

1. **`<label>` vs `aria-label`.** `page.getByLabel("Email")` matches *either* an `aria-label` or an associated `<label>`. The only precedent in this file for the same problem — `waitForSequenceFormHydration` — deliberately does **not** use an attribute selector; it walks `input.labels?.[0]?.textContent`. `editor.tsx` confirms why: every field in this codebase's forms is `<label htmlFor>` + `<span>Name</span>`, no `aria-label`. If login follows that house style, the selector is null forever.
2. **Exact vs substring.** `getByLabel("Email")` is substring/case-insensitive, so it also matches a label of `"Email address"`; `[aria-label="Email"]` is exact and would not.
3. **Missing `type` attribute.** React does not serialize a default `type` on `<button>`, and the shadcn `Button` in `editor.tsx` is used as `<Button onClick={...}>` with no `type` prop. `button[type="submit"]` is an attribute-presence selector — it matches only if the attribute is literally in the DOM. (Note the existing diagnostic path has the same pattern at `form?.querySelector('button[type="submit"]')`, but that's diagnostics-only, so it has never proven the attribute exists.)

The failure mode is not a flake: `signIn` is called by four tests, so a mismatch is a deterministic 10s red across the suite, and it is **indistinguishable from a genuine hydration stall** — the `attachBrowserDiagnostics` DOM capture only looks for the sequence-form `Name` input, so on `/login` it emits `nameInput: null, createButtonDisabled: null` and tells a triager nothing.

Either attach the login page markup as evidence, or make the probe label-agnostic the way the approved sibling helper already is — e.g. find inputs by `input.labels?.[0]?.textContent?.trim()` OR `getAttribute("aria-label")`, and reach the button via `emailInput.form?.querySelector("button")` rather than the `[type=submit]` attribute. Dropping the button from the readiness set entirely would also be defensible; `waitForSequenceFormHydration` checks a single input and was approved on that basis.

The "fails closed" comment is accurate for the `__reactProps` part (React's `hydrateInstance` calls `updateFiberProps` on every hydrated host node regardless of handlers, so the probe is valid *once the node is found*) — but it does not cover a selector that never matches in the first place.

---

## What I verified as sound

- **`response.finished()` is the correct guard, not a belt-and-braces addition.** Next streams server-action responses; `callAction` resolves when the return value deserializes, which precedes body completion. That is a mechanism that produces exactly the captured `POST /sequences/<id>/edit` `ERR_ABORTED` — the client closed the dialog and navigated while the stream was open. `waitForResponse` alone (headers) would not have caught it; `finished()` does. The root-cause narrative and the fix are consistent with the CI6 artifact.
- **`waitUntil: "domcontentloaded"` is evidence-backed and does not weaken anything.** With no `navigationTimeout` in `use`, `page.goto` inherits the test timeout, which is precisely the reported 120s expiry on a lead page whose DOM had rendered. Every call site still gates on a real assertion (`enroll-in-sequence-button` visible, or `replyBody` / `paused (inbound_reply)` visible) before interacting, all under the 10s `expect` timeout. No forced clicks, no retried sends, no relaxed assertions.
- **`confirmImpact` does not interfere with the new save wait.** `AddStepButton.onSave` has no confirm at all, and `onSaveMeta`'s `confirmImpact` short-circuits at `total_enrolled === 0` — which holds in test 1, since `seedLead("enroll")` runs after the save. (Landmine worth knowing: Playwright auto-dismisses dialogs, so if that button ever runs with enrollments > 0, no POST fires and `clickAndAwaitServerAction` burns the full 15s. Not a blocker today.)
- **Timeout budget is fine.** The new waits (10s login hydration, 15s per action POST) are bounded and only consumed on failure paths; a healthy `waitForResponse` resolves at action latency. Keeping 120s unchanged is correct — the prior 120s exhaustion was the `load`-event hang, which DCL removes.
- **`response.ok()` is weak but harmless** — server actions return 200 even on action-level failure, so it only excludes 4xx/5xx. The DB polls remain authoritative, so this adds a check without substituting for one.

## Risks I am flagging as hypothesis, not blockers

- **The enroll CTA is now clicked after DCL with no hydration readiness.** If the lead page's `load` never firing means script chunks were still outstanding, then `toBeVisible()` on `enroll-in-sequence-button` can pass against server markup whose click handler isn't attached — the dead-click failure mode the login probe was added to prevent. This is asymmetric with B2's reasoning, and it's the one place the patch loosens a readiness boundary. I have no artifact showing it actually misfires, so I'm not blocking on it; if you generalize the `__reactProps` probe for B2 anyway, pointing it at the CTA is nearly free.
- **DCL is applied to lead navigations only.** `page.goto("/login")`, `/sequences/new`, and the three `page.reload()` calls still use default `load`. Nothing in the CI6 evidence makes the stall route-specific, so if it's a dev-server property rather than a page property, those paths retain the 120s exposure. Unverified either way.

Nothing else in the patch requires change. Fix B1 (one flag, two call sites) and resolve B2 (evidence or a label-agnostic probe), and I expect this to be approvable on the next pass.
