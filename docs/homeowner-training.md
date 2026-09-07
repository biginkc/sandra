# Homeowner practice calls

This is Sandra's transport and administrative exception for the dedicated
Switchboard homeowner number. It does not change Live Coach scripts, offer
branches, recommendations, or microphone/transcript processing.

## Configuration and rollout

Apply `20260907120000_homeowner_training_call_purpose.sql` through the established
test-to-production migration workflow before enabling training, then configure
the server-only variables. Flag-off code remains compatible with the old schema:

- `HOMEOWNER_TRAINING_NUMBER`: exact owned E.164 training number.
- `HOMEOWNER_TRAINING_OPERATOR_IDS`: comma-separated authenticated operator UUIDs.
- `HOMEOWNER_TRAINING_ENABLED=true`: enables the exception for those operators.

Invalid configuration denies the exception. Keep the number configured when
turning the flag off; it remains reserved and cannot fall through to CRM
matching. Configure the same destination and operators in Jitter. Its separate
provider calling-window exception is required for after-hours practice.

Reps type the number in the ordinary manual dialer. The target and recent calls
show **Internal training — AI homeowner**. The call is unlinked even if someone
has added that number to CRM. Lead-linked dialing of the number is rejected.
The existing Coach feature flag and operator permissions still apply.

## Isolation and call evidence

The server creates an `internal_training` call activity before releasing the
connect capability. This preserves the label when a rep abandons wrap-up and
allows existing Jitter writeback/transcript endpoints to resolve an unlinked
call. The capability signs the destination and purpose. Training wrap-up cannot
associate a seller, schedule a callback, set outreach disposition or request
DNC. Database constraints preserve the call purpose and prevent CRM links.

No new Jitter request field is required. No training contact or property needs
to be created. Fictional scenario facts live in Switchboard, so CRM property
context remains empty while the rep chooses the offer path in Live Coach.

## Verification

`node scripts/rehearse-homeowner-training.mjs` uses a disposable local PostgreSQL
cluster to exercise the actual migration and existing provider writeback and
transcript functions. It covers before/after-wrap delivery, repeated enrichment,
server-only creation, immutable purpose and denied customer links/actions.
Focused server-action tests cover off-hours dialing without CRM access, disabled
reservation, forged targets, signed identity and logging failure teardown.

Deployment acceptance still requires a real Sandra call: confirm homeowner
answer, both audio directions, interruption, fresh scenario on redial, separate
rep/homeowner Live Coach transcript lines, and no customer workflow activity.
Switchboard audio alone cannot establish Sandra's live transcript feed.
