# Actual SSR cookie / PostgREST JWT transport proof

Run only with the root-approved exclusive owned T2 grant:

```
node --conditions=react-server --import tsx experiments/inbox-jwt-transport-proof/run.ts --run-owned-fixture
```

Uses the cached pinned PostgREST v16.1 image in the existing network-none T2 container namespace. It publishes no ports, creates only a dedicated random-password LOGIN role with authenticated/anon membership, and uses an ephemeral signing key held in memory. Existing credentials and authenticator passwords are never read or changed.

The actual Supabase SSR cookie client makes HTTP RPC requests through a curl transport inside the namespace. PostgREST validates JWT signatures/expiration before canonical SQL verifies the current session and single active organization membership. Seven groups cover valid scope/counts, forged signature, expired JWT, foreign organization and revoked canonical session.

Container and LOGIN role are removed before success evidence is written. Uniquely labeled synthetic canonical rows remain in the isolated fixture for evidence. This is not a running Next.js page, a production deployment, or a real customer/provider test.

The initial transport reached valid JWT authorization but failed workset creation because the database clock was 84ms ahead of the host. The corrected scope response supplies canonical created_at; TTL validation now uses expires_at-created_at and the browser caps local lifetime conservatively. Source changes to scope_json belong to the explicit schema child, not an invisible amendment of the bridge PR.
