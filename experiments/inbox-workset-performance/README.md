# Inbox workset scale assessment

This child depends on bridge PR #571. Private fixture implementation only; it does not enable production routes or apply production migrations.

## Results

Server EXPLAIN ANALYZE execution time, milliseconds. Ten samples; reported p95 is the maximum observed, not a precise percentile estimate.

| Maintained rows | Path | Counts p95 | First page p95 |
| --- | --- | ---: | ---: |
| 120,000 (108,000 known) | Previous JSON/SRF path | 2,631.982 | 339.586 |
| 120,000 | Typed metadata + bounded query | 70.153 | 1.088 |
| 360,000 (324,000 known) | Previous counts | exceeded 60,000 timeout | not remeasured |
| 360,000 | Typed metadata + bounded query | 323.960 | 2.283 |

The old page's nested plan materialized 93,828 eligible rows before sorting/limiting to100. The new nested plan uses the partial index to return100 rows inside the private function. Counts make one typed scan instead of nine JSON predicate passes. Typed mine/unread/escalated/unknown page maxima at360k were0.969–1.665ms.

Contact-name and500-day-old SMS history search return exactly the intended target beyond the first page at both volumes. Five-sample maxima at360k: typed334.002/371.090ms; previous2032.665/2080.557ms. These selective searches still scan candidate rows; this is a measured remaining cost, not proof of arbitrary-search scalability. See search-scale-evidence.json.

The fixture is512MiB/one CPU, contains both corpora, and is synthetic. Timing excludes Docker/CLI startup and network/UI costs. Baseline120k predates installation of typed metadata;360k includes it. Cache/resource conditions are not controlled production hardware. No production performance acceptance is implied.

## Implementation and proof

Typed metadata is maintained by an AFTER trigger on actual maintained summary writes, with revision fencing and tombstone removal. Bounded backfill locks source rows before upsert. Fixed predicate templates bind every user value. Keyset and limit execute inside the query; the existing authenticated wrappers retain session/epoch fencing and opaque cursors. Unknown unread remains null.

An independent Python modulo oracle verifies overlapping counts. Ordered page results match the old predicate path;80 small-fixture cases cover ten views, hide-noise, contact/history/literal search. Existing canonical bridge, cursor, and search suites passed against the new wrappers. Maintained owner/expiry/tombstone writes propagate. Full canonical property write→queue→worker capture and human-name refresh remain integration gates; this receipt does not claim them. Outcome facets are a separate followup from work-filter counts.

The scope DTO adds canonical created_at so its15-minute duration can be checked against expires_at without comparing different host clocks. Frontend's real JWT transport proof separately tested this.

## Reproduction

Only run mutations with explicit ownership of the guarded disposable T2 fixture. Fresh bridge run.py includes typed-filters.sql before parity-v2.sql. For an existing bridge, install.py creates typed schema and performs bounded corpus backfill; it refuses duplicate install. baseline-counts.sql is an isolated private copy of the prior count function for measurement, not an application API.

Seed one size per invocation: run.py --run-owned-fixture --seed --size 120000 --variant baseline (use separated flag/value tokens). Then install typed schema, measure --variant typed, seed --size 360000, and measure typed. The preserved360k baseline failure is a stop-on-timeout receipt; do not retry automatically. nested-plans.py captures actual nested plans via session-only auto_explain. search-samples.py adds uniquely synthetic canonical contact/SMS samples and refuses an existing evidence file. parity-proof.py creates fresh small fixtures through the bridge search harness.

verify.py checks source hashes and syntax; --installed additionally compares private installed function bodies read-only after validating the fixture marker/container. Evidence files retain original measurements; later source manifests verify the installed candidate, not a retroactive claim that every historical timing used the final harness text.
