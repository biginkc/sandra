<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Continue through the next unblocked step
For Sandra work, do not stop after a leaf task if the next action is obvious and does not require user authorization. Keep a visible checklist, mark completed items, and continue to the next unblocked step. Only pause when the remaining work needs Jarrad's decision, credentials, destructive-action approval, spending approval, or another authorization that cannot be safely inferred.

When blocked, state the exact blocker and the next command/action that will run once unblocked. This is especially important for PR/debug/verification workflows: continue from diagnosis to fix, tests, deploy/checks, browser verification, and issue/PR updates without waiting between routine steps.

Do not turn optional housekeeping into a stopping point. If a commit, cleanup, follow-up issue, or similar action is not required to continue and was not explicitly requested, mention it as a note and keep going, or close with "done" only when the broader task is genuinely complete.

When Jarrad provides a durable instruction or capability update mid-thread, acknowledge it briefly, then resume the active queue or explicitly restate the real blocker. Do not end on the acknowledgement alone unless there is no active task or the remaining task is truly Jarrad-owned.

# Worktree and PR autonomy
Always do Sandra code or documentation writes in a git worktree. Do not write directly in the main checkout when creating a branch, fixing code, updating docs, or preparing a PR.

Jarrad's approval is required before merging into `main`, `master`, a release branch, a shared branch, or any branch owned by Jarrad or another agent. Approval is not required for Codex-owned integration inside a Codex-owned worktree or feature branch.

Codex may create worktrees, create branches, commit changes, push branches, open PRs, update PR branches, rebase or merge `main` into its own worktree branch, and merge/cherry-pick agent-owned local branches into its own worktree branch when that is the sensible next engineering step. Use judgment to segment PRs by coherent reviewable units, but do not stop merely because branch, PR, or worktree integration mechanics are involved.

Destructive commands still require explicit authorization. Preserve unrelated user or agent changes, and coordinate before touching another agent's worktree or branch.

# Draft PRs are not automatic stopping points
Do not treat a PR being draft, review-pending, or awaiting Jarrad's merge decision as a reason to stop if there are still objective engineering steps available. Continue with non-destructive work that does not change ownership state: inspect conflicts, merge/rebase current `main`, resolve compile or test failures, run focused and full verification, check Vercel/GitHub Actions, review changed files, update the PR body/comment with current status, and clean up agent-owned worktrees/branches.

Only pause for Jarrad on a draft PR when the next step would explicitly change PR ownership/status or release state, such as marking a draft ready for review, merging a PR, closing a PR, deleting someone else's branch, applying migrations, or choosing product scope. If stopped for that reason, say exactly: "Blocked only on Jarrad decision: <decision>." Include the recommended default and the exact command/action that will run after approval.

If the PR remains draft but is mergeable and green, keep moving to read-only review and verification before stopping. A final answer may mention "draft status still needs Jarrad" only after all practical non-destructive follow-up has been exhausted.

# Browser checks vs Playwright checks
For Sandra verification, use the right browser tool for the question being answered.

Use the in-app browser or visible Chrome for human-feel checks: drawer responsiveness, click latency, skeleton/preloader timing, layout, visual polish, and whether the preview behaves the way a user expects while clicking around.

Use Playwright for repeatable proof: CI gates, auth setup, DB-backed fixtures, URL state, filter counts, regression tests, screenshots/traces on failure, and anything that should keep passing the same way tomorrow.

Human clicks do not disturb terminal/API-side checks such as GitHub Actions, Vercel checks, or `gh pr checks`. Human clicks can interfere only when an agent is actively controlling the same visible Chrome window with browser automation or AppleScript; call that out before taking control.
