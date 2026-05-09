# 04-07 Summary: Slack DM Dispatcher + Interactivity Webhook

## What Shipped

- Added `src/lib/integrations/slack/blocks.ts` with canonical Block Kit composers:
  - `buildTaskAssignedBlocks`
  - `buildMarkedDoneBlocks`
- Added `src/lib/integrations/slack/dispatch.ts` with the contracts Plan 04-10 will call:
  - `dispatchTaskAssignedSlack(input)`
  - `completeTaskFromSlack(input)`
  - `refreshSlackMessage(input)`
- Added `POST /api/webhooks/slack/actions` for Slack Block Kit interactivity:
  - verifies Slack HMAC over the raw body
  - validates Slack's five-minute timestamp window through `verifySlackSignature`
  - parses the form-encoded `payload`
  - allowlists `mark_done`
  - UUID-checks `action.value` before any task mutation
  - acks Slack immediately and runs completion/update work in `after()`

## Canonical Block Shape

The assigned-task DM is:

1. header: `Task assigned: ${taskTitle}`
2. context:
   - `*${taskTypeLabel}* · Due ${dueLabel} · <${deepLink}|Open in Sandra>`
   - property address
3. actions:
   - `block_id: "task_actions"`
   - primary button `action_id: "mark_done"`
   - button `value` is the task UUID

The completed-state update is:

1. header: `✓ Marked done: ${taskTitle}`
2. context:
   - `Done by ${doneByUserName} · <${deepLink}|Open in Sandra>`
   - property address

The committed inline snapshot lives in `src/lib/integrations/slack/blocks.test.ts`.

## Dispatch Contracts

`dispatchTaskAssignedSlack(input)`:

- checks the assignee's Slack integration preference
- decrypts the assignee's Slack bot token
- opens a DM with `conversations.open({ users: externalAccountId })`
- posts the task blocks with `chat.postMessage`
- persists `tasks.slack_channel_id` and `tasks.slack_message_ts`
- never throws across the boundary; failures return `{ sent: false, reason }` and report via `reportError`

`completeTaskFromSlack(input)`:

- resolves the Sandra user from `user_oauth_tokens.external_account_id`
- requires `tasks.assignee_id` to match that resolved user
- treats already-completed tasks as idempotent success
- calls `completeTask(admin, taskId, resolvedUserId)` for the actual mutation

`refreshSlackMessage(input)`:

- reloads the task and property address
- decrypts the assignee's bot token
- calls `chat.update` with the completed-state blocks
- never throws across the boundary; failures return `{ ok: false }`

## Slack App Config

Set Slack Interactivity Request URL to:

```text
https://sandra-sooty.vercel.app/api/webhooks/slack/actions
```

## Cross-User Denial

The webhook does not trust `payload.actions[0].value` beyond UUID shape. `completeTaskFromSlack` maps the clicking Slack user ID to a Sandra `user_id`, then verifies the task is assigned to that user before mutating. A different Slack user clicking another assignee's task returns `not_assignee` and leaves `tasks.status` unchanged.

Proof:

- `src/lib/integrations/slack/dispatch.test.ts` covers `not_assignee`.
- `src/app/api/webhooks/slack/actions/route.integration.test.ts` seeds two Slack users against the test Supabase project and verifies the cross-user click leaves the task `open`.

## Verification

- `npm run typecheck`
- `npm test -- --run src/lib/integrations/slack/blocks.test.ts src/lib/integrations/slack/dispatch.test.ts src/app/api/webhooks/slack/actions/route.test.ts`
- `npm run test:integration -- --run src/app/api/webhooks/slack/actions/route.integration.test.ts`
- `npx eslint src/lib/integrations/slack/blocks.ts src/lib/integrations/slack/blocks.test.ts src/lib/integrations/slack/dispatch.ts src/lib/integrations/slack/dispatch.test.ts src/app/api/webhooks/slack/actions/route.ts src/app/api/webhooks/slack/actions/route.test.ts src/app/api/webhooks/slack/actions/route.integration.test.ts`
