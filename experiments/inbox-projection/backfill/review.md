# Backfill correctness review

Independent review found no demonstrated source correctness blocker at setup
SHA256 d7ff8e2f2c39328a8b25e04fdde9e6fe201ea5f721158789ef4d37820e9ed4d0.
Canonical source locks precede private writes, waited tuples are rechecked,
and checkpoint fencing commits seeding and progress together. New collision
inspection generations remain pending after an older inspection acknowledges.

The initial review requested tenant-departure concurrency coverage and narrower
rollback claims. The final source-lock wait test verifies the old organization
scan returns no moved row, does not resurrect its edge, and preserves departing
and destination invalidations plus the destination edge. Root inspected those
assertions and matching receipt. Late-fence claims explicitly cover the tested
known dirty counter and checkpoint, not every possible registry/edge effect.

The added collision test observes an inspector lock wait after its source probe,
adds another thread in the lock-holder transaction, and verifies the old result
leaves the new generation pending. A subsequent inspection records the exact
pair. Root inspected the harness and matching source-bound receipt.

These schedules do not prove general deadlock freedom, process-death recovery,
production sizing or a full capture cutover. Fingerprints cover observed top-level
trigger definitions, not helper changes or privileged bypass between checks.
No duplicate repair is performed. Production activation remains separately gated.
