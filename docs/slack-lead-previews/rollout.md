# Slack lead previews: rollout and rollback

The approved plan and reviews in this directory define the implementation contract. This runbook records the activation gates; it does not authorize a channel or turn on previews.

## Before activation

1. Finish code review and repository checks against the exact candidate commit. Resolve My Leads dependencies against current main; do not import an unreviewed branch.
2. Apply the foundation migration through Sandra's established test-then-production migration workflow. Confirm both successful workflow runs before connecting the new preview installation.
3. Configure the Slack app's actual `A…` app ID as `SLACK_APP_ID`. It is distinct from the OAuth client ID. Keep existing OAuth credentials and encryption/signing secrets out of reports and logs.
4. Register `sandra.bmhgroupkc.com` for custom unfurls. Request bot scopes `links:read`, `links:write`, `channels:read`, `groups:read`, and `users:read` alongside the existing integration scopes. Configure the Events API endpoint at `/api/webhooks/slack/events` and the events required by the implementation: link sharing, installation removal, token revocation, and channel sharing.
5. Enable the preview OAuth enrollment path only after its schema is available. A signed-in Sandra user starts the explicit `/api/oauth/slack/start?preview=1` flow. Reinstall or reauthorize the app after changing its scopes or unfurl domains. Legacy Slack account mappings alone do not authorize previews.
6. Verify the installed bot's actual workspace, app ID, granted scopes, and account link. Verify the app can inspect the intended internal destination, including private-channel membership where applicable.
7. Have an authorized organization owner approve the exact installation, organization, and channel through the authenticated `/api/integrations/slack/channels/approve` endpoint. Approval includes `sharingPolicyAcknowledged: true`: everyone who can read that channel can read the preview's lead details and message excerpts. A discovered channel name or an OAuth installation is not this acknowledgement.
8. Verify the deployed one-minute `/api/cron/slack-unfurl-sweep` schedule and its `CRON_SECRET` authorization. Accepted events must survive a process restart and be picked up by cron.
9. Obtain explicit authorization for a synthetic canary post in the approved destination. Use run-owned data and verify the actual Slack card, the authenticated My Leads button, denial cases, retries, and cleanup. Do not send seller messages or calls as part of this check.
10. Enable `SLACK_LEAD_UNFURL_ENABLED=1` only after the preceding gates pass. Record the exact release commit, deployment, migration runs, approved destination, and canary evidence.

## Intended card

The card contains the lead name and address, owner, latest My Leads attempt outcome, confirmed Messages disposition, last successful contact, and the latest three SMS excerpts in chronological order. The excerpts use `Us:` and `Them:` separated by arrows, with attachment and delivery-failure labels. The CTA opens the exact lead in the viewer's own authorized My Leads queue. No next action or inferred negotiation status is displayed.

## Rollback

Disable `SLACK_LEAD_UNFURL_ENABLED` to stop disclosure and delivery. Disable `SLACK_PREVIEW_OAUTH_ENABLED` to stop new preview enrollment if needed. Keep the additive database foundation in place, retain the seven-day cleanup path, and use installation/channel revocation when the corresponding authorization is withdrawn. Do not drop the outbox to roll back application behavior. Already-posted Slack cards are snapshots and require separate Slack message management if removal is requested.

## Evidence to retain

Retain identifiers, statuses, candidate SHAs, review verdicts, test results, migration/deployment references, and synthetic canary evidence. Do not retain tokens, signing secrets, message bodies from real leads, or raw event payloads in operational logs.
