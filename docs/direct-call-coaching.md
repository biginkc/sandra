# Direct call coaching

Direct calling is authorized by active Acquisitions membership. The browser receives neither the Telnyx API key nor the media admission secret. The calling configuration and 180-second pilot call limit remain independent of coaching.

Sandra's signed Telnyx webhook binds the connected direct-call UUID to an immutable reviewed script in `coach_call_index`, then requests both media tracks from the owned seller leg. Repeated events use the same provider command ID. Failed starts leave the event unprocessed for provider redelivery; they do not issue another Dial. The script binding is insert-once and must retain the same operator and property.

The standalone `services/direct-coach` service receives a short-lived HMAC capability identifying that call and seller leg. It verifies current call ownership and script binding before admitting audio to paid transcription. It publishes to the existing private `coach:{directCallId}` channel. The browser uses the direct-call UUID, rather than its local wrap-up token, for this subscription.

## Configuration

Sandra server:

- `DIRECT_COACH_ENABLED=true`
- `DIRECT_COACH_STREAM_URL=wss://<service-host>`
- `DIRECT_COACH_STREAM_SECRET`: shared secret of at least 32 characters; generate randomly and keep server-side.
- `DIRECT_COACH_SCRIPT_SLUG=closr-outbound` for the reviewed outbound POC.

Sandra build:

- `NEXT_PUBLIC_COACH_UI_ENABLED=1`
- `NEXT_PUBLIC_DIRECT_COACH_ENABLED=1`
- `NEXT_PUBLIC_COACH_WIRE_DIGEST_STRICT=1`

The direct line uses its assigned server-side script. Other transports retain their existing script picker. A missing binding or failed stream must remain visibly unavailable/degraded; replay or fabricated events cannot establish live acceptance.

Deploy and verify the service before enabling the Sandra flags. Apply recording migrations through the existing test-to-production migration workflow. Keep production call activation last. Never log capability URLs, signed recording URLs, or credentials. Disable coaching by removing its server flag and rebuilding without its public flag; independently disable the calling application when stopping the pilot itself.

## Acceptance

A release needs a real owned-target call from Sandra with both speaker transcripts, an approved visible card, and authenticated playable recording that retains known opening and closing speech. A provider-only call, paced replay, or synthetic Realtime renderer is supporting evidence, not this acceptance test. Browser/network failure tests must independently confirm that both provider legs end within the authorized disconnect bound. Missing media, lost finalization, or incomplete recordings must remain explicit failures.
