# Jordan training lead seed

Run only after the reviewed training guards and application changes are deployed. This creates one actual fictional contact/property in Sandra's existing lead UI, marked `is_training`, with `new_lead` status. Calls still retain null customer references. Do not create a replacement lead manually or remove training guards to make seeding succeed.

Source: released Switchboard profile revision `d49eb24670e6347c4367919473fc3cfadbe97087cd1b8b5896ec0e2921f43c51`. Number: **816-544-0196**. The profile includes known property facts and a plainly labeled factual configuration note. It creates no call history, consent, email, appointment, agreement or outreach record. No hidden offer floors are published.

## Operator execution

Use the established privileged PostgreSQL operator workflow (as in `scripts/apply-esign-production-migrations-atomically.mjs`), against the Sandra production project `copflsklaefwzipsrjqz`. Retrieve its database connection through the authorized **1Password service account**, never personal sign-in. Supply `SANDRA_PRODUCTION_DATABASE_URL` through the protected process environment; never put credentials in command arguments, output, notes or Git. Validate the target project before running. The command requires a privileged server database role and sets a transaction-local service-role claim for the server-only seed guard.

Default, read-only preflight:

```sh
node scripts/seed-jordan-training.mjs
```

After exact-diff review, migration completion, deployed application guard verification and operator release authorization:

```sh
node scripts/seed-jordan-training.mjs --apply
node scripts/seed-jordan-training.mjs
```

The script checks all seven deployed training triggers and the training marker. Apply locks the three affected tables briefly within one transaction; lock timeout is five seconds. Stable IDs and collision checks prevent a second contact/property/note. Any partial identity, existing use of the number, wrong organization, altered binding, or incompatible seed record aborts without adopting or overwriting it. A repeated successful run reports `already_seeded`. Future profile revisions need reviewed updates to both sources; this script does not overwrite operator edits or synchronize profiles automatically.

Lead property ID: `b4b8d7cb-d51e-4af8-888a-a15e07001962`. The desired $210,000 price uses the existing `listing_price` structured field; the factual note labels it as desired price, not a claim of a published listing. No county, ZIP, valuation, repair estimate, consent or activity dates are invented. Notes have no fabricated human author.

## Verify and retain evidence

Keep command results and deployed revision in the protected release ledger. Confirm one marked property, one dedicated contact, and one profile note. Open the existing lead page and verify its factual fields, training label and disabled customer actions. Use the existing Call button only under the root's authorized live-test procedure and exclusive telephony lease. Verify caller admission, Live Coach context, two-way audio, transcript/recommendations, manual Hang up and training-only wrap records. Provider answering alone does not establish Sandra integration.

The permanent training marker deliberately prevents deleting or converting this record through normal workflows. If the seed conflicts, stop and inspect the specific records privately; never clear DNC or suppress guards. A failed seed transaction rolls back entirely. Disable training calling through its established configuration if an operational rollback is needed.

## Local rehearsal

Run `LOCAL_REHEARSAL_DATABASE_URL=postgresql://postgres@127.0.0.1:19487/postgres node scripts/seed-jordan-training-rehearsal.mjs` against your local disposable PostgreSQL fixture server (adjust the port for your environment). The URL must target localhost. Missing fixture roles are created as NOLOGIN roles; existing roles are preserved. It creates and drops a dedicated process-specific database, loads representative tables plus the actual training-guard migration, and verifies dry-run/no writes, apply, repeated apply, age 47, disabled AI/skip-trace, collision refusal and missing-guard refusal. The seed's explicit `--local-rehearsal` flag rejects non-local hosts or any database name outside the dedicated fixture pattern. Production execution never uses that flag.

The seed explicitly sets `ai_responder_disabled=true` and `skip_trace_disabled=true`; these do not replace the deployed workflow guards. Source remains unspecified rather than inventing marketing provenance.

The seed preserves the phone line type as `unknown`. Immediately before inserting the contact, it uses the existing transaction-local `sandra.allow_unverified_lead_phone` setting from the lead-intake migration; it does not invent a verified carrier type or change a database guard. The local rehearsal loads the actual phone-type trigger as well as the training guards, proves a normal unknown-type insert is rejected, and verifies the seed succeeds with the type still unknown.
