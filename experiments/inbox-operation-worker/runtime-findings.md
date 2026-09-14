# Runtime preparation findings

The first full-schema companion attempt stopped before mutation because its prerequisite checker expected the raw bridge authorization body. The reviewed production compiler adds the serving-enabled guard. A read-only exact diff showed that guard was the only difference. The checker now applies the identical deterministic guard insertion and still compares the full resulting function body; it does not strip or bypass the serving gate.

Source review also found that an empty outbox was incorrectly sufficient for recent dispatch success while Restate could be unavailable. Readiness now checks the bounded, cached `/restate/health` ingress response and requires the registered metadata service before querying the canonical baseline. The endpoint was checked against pinned Restate1.7.5 source and the existing owned T1 instance; full worker restart evidence remains separate.
