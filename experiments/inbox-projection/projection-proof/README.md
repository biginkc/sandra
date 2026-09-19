# T2 minimal message projection rehearsal

Status: the strengthened continuation passed all 11 checks on 2026-09-13 against the owned offline canonical-schema fixture. See evidence-hardened.json for the exact harness/setup hashes and source/container identity. The original evidence.json is preserved; its ACL check accepted any SQL failure and its read check did not compare head/stamp, so it is weaker evidence. This is not a production migration or complete Inbox projection implementation.

The candidate uses the actual canonical messages table and existing AFTER inbound-head allocator. A second AFTER trigger records only affected OLD/NEW organization+conversation keys. It ignores revision-only nested self-updates and never materializes the potentially stale outer NEW tuple. A later single-statement snapshot reads canonical finalized rows, dirty generation and current projection revision together.

The private commit function locks dirty first, then projection. It rejects a candidate older than the acknowledged generation or based on an obsolete projection revision. A valid candidate may acknowledge generation G even when dirty generation is newer; remaining work stays pending. The commit section reads/writes only private tables with no canonical foreign keys. It does not re-read/lock messages while holding the dirty lock. This is the deliberate starvation/deadlock boundary being tested.

Minimal fields: SMS message count, unread inbound count, latest ID/time/120-character preview and latest inbound revision. No contact/property/consent fanout, query authorization, durable worker loop, index optimization or production scale claim. Dirty generations are internal evidence, not global commit order. Capturing all canonical writers, TRUNCATE/import bypass and future trigger/FK changes is outside this test.

After root grants an exclusive fixture window, run:

```sh
python3 experiments/inbox-projection/projection-proof/run.py --run-owned-fixture
```

The script refuses optimized Python and uses the shared fixture guard to require the pinned container/image, ownership label, running state, no network or published ports, 512 MiB/one CPU limits, completed ready bootstrap receipt, disabled cron, correct marker and postgres allocator owner. Fresh mode installs once in a new private schema and does not drop existing objects. Successful tests leave synthetic records/private tables for inspection; source-lock and rollback cases release their transactions. The candidate is intentionally outside supabase/migrations.

Checks executed: nested stamp correctness; delayed old snapshot rejection; progress with newer dirty work pending; projection CAS conflict; old/new identity dirtying; read/delete/empty state; source rollback; commit completing while canonical row is locked elsewhere; private-role access denial. The harness completed successfully. This does not certify complete projection writer coverage or production performance.


For the already installed fixture, after an exclusive database window is granted:

```sh
python3 experiments/inbox-projection/projection-proof/run.py --run-owned-fixture --continue-installed
```

Continuation does not reinstall, reset or drop anything. It requires the original successful receipt's setup hash to match the unchanged local SQL, compares each installed function body and owner/definer/search-path settings, verifies the enabled dirty trigger and absence of private foreign keys, and uses new UUIDs plus a unique organization name. These checks are targeted integration guards, not a complete catalog equivalence proof. Each run leaves its synthetic organization and records for inspection. Copy evidence-hardened.json before any further rerun to retain that receipt; the original evidence.json remains untouched.

The stronger ACL test requires SQLSTATE 42501 and the expected private-schema permission denial for each role; unrelated SQL failures cannot pass. The read test captures actual positive canonical arrival head and per-message stamp before and after marking read, requires equality, and separately verifies the unread projection changes.

The source-lock holder's entire lifecycle, including creation and barrier, is inside cleanup. It has a 12-second barrier deadline, bounded shutdown/termination waits, and a 15-second server idle-transaction timeout. Other SQL subprocesses have a 30-second deadline plus server statement/lock timeouts. The successful run exercised normal lock acquisition and release; it did not inject process death or a barrier timeout to prove every cleanup fallback. The post-run check found zero idle-in-transaction sessions and the canonical head trigger still enabled.

continuation-metadata.json records the current message index definitions and approximately 106,036 catalog-estimated rows after the separate index rehearsal. This proof creates tiny new conversations within that fixture. Neither total fixture size nor the successful lock test establishes production latency, high-contention throughput, bounded scan cost, full writer coverage, or acceptable canonical-trigger write amplification. Core setup.sql is unchanged.
