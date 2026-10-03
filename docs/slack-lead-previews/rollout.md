# Slack lead previews: rollout and rollback

The approved plan and reviews, as superseded by the user-authorized workspace-policy amendment, define the implementation contract. This runbook records the activation gates; it does not authorize a channel or turn on previews.

## Before activation

1. Finish code review and repository checks against the exact candidate commit. Resolve My Leads dependencies against current main; do not import an unreviewed branch.
2. Apply the foundation and workspace-policy migrations through Sandra's established test-then-production migration workflow. Confirm both successful workflow runs before connecting the new preview installation.
3. Configure the Slack app's actual `A…` app ID as `SLACK_APP_ID` and its public OAuth client ID as `SLACK_CLIENT_ID`. It is distinct from the OAuth client ID. Keep existing OAuth credentials and encryption/signing secrets out of reports and logs.
4. Register `sandra.bmhgroupkc.com` for custom unfurls. Request bot scopes `links:read`, `links:write`, `channels:read`, `groups:read`, and `users:read` alongside the existing integration scopes. Configure the Events API endpoint at `/api/webhooks/slack/events` and the events required by the implementation: link sharing, installation removal, token revocation, and channel sharing.
5. Enable the preview OAuth enrollment path only after its schema is available. A signed-in Sandra user starts the explicit `/api/oauth/slack/start?preview=1` flow. Reinstall or reauthorize the app after changing its scopes or unfurl domains. Legacy Slack account mappings alone do not authorize previews.
6. Verify the installed bot's actual workspace, app ID, granted scopes, and account link. Verify the app can inspect the intended internal destination, including authoritative private-channel information where applicable. Unfurling itself does not require bot membership; inaccessible private destinations fail closed.
7. An authenticated organization owner enables lead-link previews once for the verified Slack installation in `/settings/integrations/slack-previews`. The acknowledgement covers eligible internal public and private channels: anyone who can read the destination can see the lead details and message excerpts. No per-channel selection is required. Slack retention, notifications, search, forwarding and digests can retain or redistribute those excerpts. Live Slack identity/type/sharing checks and CRM sharer/lead authorization still run before disclosure. Explicit channel revocations take precedence; disabling policy stops that installation’s previews and cancels pending work.
8. Verify the deployed one-minute `/api/cron/slack-unfurl-sweep` schedule and its `CRON_SECRET` authorization. Accepted events must survive a process restart and be picked up by cron.
9. The user has authorized activation and synthetic acceptance under the workspace-policy amendment. Use one eligible internal destination for the run-owned synthetic canary; this test destination does not restrict normal previews to that channel. Enable signed event intake with `SLACK_LEAD_UNFURL_INGEST_ENABLED=1` while keeping `SLACK_LEAD_UNFURL_ENABLED` off. The cron must still claim no jobs. Use an isolated server/CLI runner to claim only the exact run-owned synthetic job and invoke the same internal claimed-job processor, retaining all production authority and lease checks; keep general delivery disabled. Use run-owned data and verify the actual Slack card, the authenticated My Leads button, denial cases, retries, and cleanup. Do not send seller messages or calls as part of this check.
10. Enable `SLACK_LEAD_UNFURL_ENABLED=1` only after the preceding gates pass. Record the exact release commit, deployment, migration runs, approved destination, and canary evidence.

## Intended card

The card contains the lead name and address, owner, latest My Leads attempt outcome, confirmed Messages disposition, last successful contact, and the latest three SMS excerpts in chronological order. The excerpts use `Us:` and `Them:` separated by arrows, with attachment and delivery-failure labels. The CTA opens the exact lead in the viewer's own authorized My Leads queue. No next action or inferred negotiation status is displayed.

## Rollback

Disable `SLACK_LEAD_UNFURL_ENABLED` to stop disclosure and delivery. Disable `SLACK_LEAD_UNFURL_INGEST_ENABLED` as well to stop new intake; with both off, signed link events are acknowledged as no-ops. Disable `SLACK_PREVIEW_OAUTH_ENABLED` to stop new preview enrollment if needed. Disable the installation policy to stop its previews and cancel pending work. Keep the additive database foundation in place, retain the seven-day cleanup path, and use installation/channel revocation when the corresponding authorization is withdrawn. Policy revisions and installation generations prevent old claims from returning after re-enable/reinstall. Do not drop the outbox to roll back application behavior. Already-posted Slack cards are snapshots and require separate Slack message management if removal is requested.

## Evidence to retain

Retain identifiers, statuses, candidate SHAs, review verdicts, test results, migration/deployment references, and synthetic canary evidence. Do not retain tokens, signing secrets, message bodies from real leads, or raw event payloads in operational logs.
