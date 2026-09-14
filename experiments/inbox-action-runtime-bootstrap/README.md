# Empty action runtime foundation

This fixed profile creates only `sandra_inbox_action_runtime_20260913`, guarded by `sandra-inbox-action-runtime-owned-synthetic`. It preserves the original T2 database and the running browser candidate. It does not accept a database URL.

`bootstrap.py` copies the complete Auth schema produced by the real GoTrue foundation, plus only the vendor `auth.schema_migrations` ledger. It does not copy users, sessions, refresh tokens, messages, preparations, operations, or dispatch jobs. Application-owned Auth triggers are excluded from this schema copy and recreated by the canonical migration replay and reviewed Inbox installer. The profile pins and records the original and executed bootstrap source hashes; the only substitutions are the fixed database/marker and separate evidence directory.

The first attempt exposed an app-owned Auth trigger dependency before canonical application functions existed. That attempt left only a partial Auth schema in this newly created, empty marked database. The retry verified zero identities/sessions, removed that partial schema, and copied the full vendor schema and ledger atomically after excluding application-owned triggers. This is not a production repair procedure. Subsequent canonical migrations use the original atomic per-source ledger.

`install.py` installs the existing compiled stable foundation, validates its separate concurrent indexes, completes the empty baseline, and compares all 67 installed function bodies with the reviewed compiler output. Serving stays disabled. The operations owner subsequently installs its own deterministic companion and creates its own synthetic actors/jobs. Do not rerun the bootstrap after that ownership transfer: the empty-data guards intentionally refuse it.

Actual receipts: `auth-foundation.json`, `profile-receipt.json`, `bootstrap-evidence.json`, `catalog-evidence.json`, `install-evidence.json`. No production migration or provider action occurred. The separate worker's signed delivery/restart proof is still required.
