# Independent correctness review

Reviewed setup SHA256:
841dd151a0a5e2ea623d4ac2c936e097d45af190383e906ad1184fb6d58c53b3.
No demonstrated lost-generation or old/new-key defect was found on inspection.
The final fence compares claim, expiry, scan generation, stream and cursor;
completion acknowledges the scanned generation rather than newer pending work.
Source reads precede private write locks. This does not establish deadlock freedom.

Initial runtime evidence did not execute a claim replacement after child writes
began. concurrency.py now holds the child dirty row and observes pg_blocking_pids,
replaces the claim, releases the holder, and requires stale_claim with unchanged
child generation and replacement checkpoint. The replacement worker then advances.
Independent review confirmed the receipt matches the source and closes this gap
for the tested one-child property schedule. It is not a process-death/load proof.

The initial harness also had unbounded drain loops. The final harness caps drains
at 20 batches, uses a fresh UUID namespace, retains default installation refusal,
and permits explicit continuation only after checking installed function bodies.
Eight grouped checks passed again. Original runner and receipt remain retained.

Current source/receipt hashes are checked by verify_sources.py. Before production,
address the separate writer-risk review, consent/suppression/thread capture,
command-policy versions, backfill/bypass recovery and realistic fanout overhead.
