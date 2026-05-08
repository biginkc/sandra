<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Continue through the next unblocked step
For Sandra work, do not stop after a leaf task if the next action is obvious and does not require user authorization. Keep a visible checklist, mark completed items, and continue to the next unblocked step. Only pause when the remaining work needs Jarrad's decision, credentials, destructive-action approval, spending approval, or another authorization that cannot be safely inferred.

When blocked, state the exact blocker and the next command/action that will run once unblocked. This is especially important for PR/debug/verification workflows: continue from diagnosis to fix, tests, deploy/checks, browser verification, and issue/PR updates without waiting between routine steps.

Do not turn optional housekeeping into a stopping point. If a commit, cleanup, follow-up issue, or similar action is not required to continue and was not explicitly requested, mention it as a note and keep going, or close with "done" only when the broader task is genuinely complete.

When Jarrad provides a durable instruction or capability update mid-thread, acknowledge it briefly, then resume the active queue or explicitly restate the real blocker. Do not end on the acknowledgement alone unless there is no active task or the remaining task is truly Jarrad-owned.

# Browser checks vs Playwright checks
For Sandra verification, use the right browser tool for the question being answered.

Use the in-app browser or visible Chrome for human-feel checks: drawer responsiveness, click latency, skeleton/preloader timing, layout, visual polish, and whether the preview behaves the way a user expects while clicking around.

Use Playwright for repeatable proof: CI gates, auth setup, DB-backed fixtures, URL state, filter counts, regression tests, screenshots/traces on failure, and anything that should keep passing the same way tomorrow.

Human clicks do not disturb terminal/API-side checks such as GitHub Actions, Vercel checks, or `gh pr checks`. Human clicks can interfere only when an agent is actively controlling the same visible Chrome window with browser automation or AppleScript; call that out before taking control.
