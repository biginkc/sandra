# Isolated T2 source fixture

Status: ready. The fixed disposable database completed 237 repository migration files and 13 vendor prerequisite files (250 journaled steps). `bootstrap-result.json` records exact source hashes and the source revision. `attempts.jsonl` retains earlier failures rather than hiding them.

## Scope and target

Only container `sandra-inbox-projection-t2-db`, ID `603c10117cb7ef6a07d81448dd1a25b0c1ee2787a59f75871015c4a416cac557`, through Docker host `unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock`, is accepted. It was created from Supabase Postgres `17.6.1.165`, digest `28f0e16a019e648089fc1a6d333549a55548f6019c15ae4bd7cd58b989027518`. Network is `none`, ports are unpublished, and `cron.launch_active_jobs` is `off`. No production credentials, existing customer data, or old database dump was used.

Run from the repository root only while this fixture has exclusive database ownership:

```sh
python3 experiments/inbox-projection/fixture/bootstrap.py
```

The bootstrap intentionally cannot target an arbitrary replacement container. A new disposable target requires reviewing and updating its identity guard. Do not rerun while head-proof tests hold database ownership. Infrastructure creation is owned by the parent experiment, not this script.

## Replay and recovery

Each source file executes with its ledger insert in one transaction, with ON_ERROR_STOP, a 60-second statement timeout and a five-second lock timeout. Failure rolls back that file and stops the run. A resume accepts a previously applied file only if its original SHA-256 matches the ledger. No failing application migration was silently skipped. Existing explicit transaction wrappers are normalized using a SQL-aware scanner; PL/pgSQL bodies and quoted strings remain intact. The final scanner was compared against the normalization used during replay for all 237 files with no semantic differences found. Its focused tests run with `python3 experiments/inbox-projection/fixture/transaction_envelope.py`.

Application migrations run with SET LOCAL ROLE postgres. Vendor prerequisites run as supabase_admin. An early partial replay used supabase_admin for application DDL; `correct-owner.sql` narrowly corrected non-extension public/bus objects in this disposable database to postgres. It does not use global REASSIGN OWNED. `vendor-owner-finalization.sql` restores the verified auth owner and storage grants. The ready marker is `inbox_t2_fixture.identity`, containing `sandra-inbox-projection-t2-owned-synthetic`.

The historical failed attempts exposed these missing vendor prerequisites: storage role membership setup conflicted with the image roles; auth.identities was absent; realtime.messages and its admin role were absent; storage bucket size/type columns were absent; and postgres lacked grant options on newly created storage tables. Each was resolved from pinned vendor source and the failed application file retried. Storage uses its documented install_roles=false option because roles already exist in the image.

## Vendor provenance and limits

`vendor/manifest.json` pins every applied vendor file, URL or image source, commit, and SHA-256. Auth migration templates substitute only the namespace `auth`. The image-provided storage grants migration is included because image startup ran before the new storage tables existed. Realtime role SQL is extracted from pinned upstream Ecto migrations; table/index declarations are explicitly translated into SQL. The corresponding original Ecto files are retained and hashed. Drops/ownership changes for absent predecessor tables were omitted.

This is a source-derived application-schema rehearsal fixture, not a complete running Supabase deployment. Auth and storage service APIs are not started. Realtime provides the policy prerequisites required by repository migrations, not the complete current partition/replay/runtime schema. Source migration count includes historical placeholders; it is not proof of whole-production catalog parity. Scheduled job definitions may exist but execution is disabled and network access unavailable. External provider behavior and real workload performance remain untested.

## Verified metadata before candidate installation

Metadata-only comparison with the older owned local reference found these six canonical function-definition MD5 hashes identical; all six application functions are owned by postgres:

| Function | MD5 of pg_get_functiondef |
| --- | --- |
| messages_fill_sms_conversation_id | f53ebcdab9ef858acc230aa5337c8dab |
| resolve_sms_conversation_org | d85c9361d61dc14e6c68830ff1f82e81 |
| supersede_ai_disposition_reviews_on_outcome_change | a705ce26ac381763e35b335eb3b66a66 |
| apply_global_phone_dnc_to_contact | bc65a780ded61baa594607f012e6ebf0 |
| fn_book_appointment | eb97e186d2f1bdf9ecd20128effa04c1 |
| sms_inbox_thread_page_snapshot | e6bd1cd41c9b988185da62b797cef1e0 |

Auth uid, role and jwt helper hashes also match the reference after applying actual pinned vendor migrations: ea3b41bf29e2ad573067939329aa088e, 8a3e05459e07e0633d43c6fba2a2cdf4, and 20054548ba2003f61a6bcb472175700b respectively. Their owner is supabase_auth_admin. These checks cover the named functions, not every object in either database. Proofs should use postgres and authenticated roles as appropriate; a superuser-only pass does not establish authorization correctness.

## Guard hardening after bootstrap

Container identity, pinned image identity, ownership label, running state, network/ports, 512 MiB memory and one-CPU limits, cron setting and source digests use explicit exceptions; they remain active under optimized Python. `python3 -O experiments/inbox-projection/fixture/guards_test.py` passed four pure test methods, including eight altered-container rejection cases. These tests use no Docker or database calls. The live container metadata confirmed the exact image ID and resource limits. Historical receipts were preserved and bootstrap database writes were not rerun during this hardening.
