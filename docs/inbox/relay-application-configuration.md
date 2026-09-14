# Inbox application to private Electric relay

The disabled Inbox sync route uses the reviewed relay for hosted deployment. Configure these server-only values together:

| Next application value | Meaning |
| --- | --- |
| `INBOX_ELECTRIC_SHAPE_URL` | HTTPS relay endpoint ending exactly in `/v1/shape`, without credentials, query, or fragment. |
| `INBOX_ELECTRIC_RELAY_TOKEN` | Same high-entropy secret as the relay service's `INBOX_RELAY_TOKEN`; 32–256 base64url characters. |
| `INBOX_ELECTRIC_PROJECTION_TABLE` | Fixed projection relation, currently `inbox_bridge.summaries`, matching the relay's relation. |
| `INBOX_ELECTRIC_UPSTREAM_MODE=relay` | Default mode when omitted. |

Generate one common random 32-byte hex token and provision that same value to both server configurations through the deployment secret store; do not commit or log it.

The application adds the secret only to the upstream Authorization header. It is never a public environment variable, browser parameter, URL credential, or response field. Missing or malformed configuration returns a private, non-cacheable 503 before creating the Supabase client. The independent `INBOX_WORKSPACE_SERVER_ENABLED` gate still defaults off.

For the explicitly owned local synthetic harness only, set `INBOX_ELECTRIC_UPSTREAM_MODE=owned-local` with a loopback HTTP `/v1/shape` URL containing an explicit port. This mode is accepted only with Node development/test and omits the relay token. Production rejects it. Existing local harnesses must opt into this profile when adopting this route.

This source change does not create infrastructure, install the required canonical SQL RPCs, set deployment secrets, or enable the Inbox. Activation also requires the reviewed relay deployment, atomic sync RPC installer, projection/publication readiness, and the broader rollout checks.
