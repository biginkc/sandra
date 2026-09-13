# Actual gateway / Electric URL feasibility

Run from repository root with the existing owned T1 services:

```
node --conditions=react-server --import tsx experiments/inbox-gateway-url-proof/run.ts --run-owned-fixture
```

The harness verifies the exact Electric container/image/loopback binding and owned database marker before creating its uniquely named fixture table. It adds only this table to the existing manual publication, then verifies publication restoration and closes its database client before writing success evidence. The narrow table requires REPLICA IDENTITY FULL, which must also appear in migration and WAL/storage budget verification.

The initial source lacked replica identity full: its 100-row request failed 503, while the actual 500-row request failed 414. `initial-missing-replica-identity.json` retains this diagnostic. After correcting the table, 100 returned 200/100 rows and 500 still returned 414 (`before-partition-evidence.json`). The archived source is text because it targets the previous singular-handle gateway interface.

The current actual gateway divides one immutable 500-member scope into five disjoint 100-member shapes. Each real Electric response must return exactly 100 unique rows. The longest admitted cursor/handle/offset combination also reaches Electric without a URI-length error; its deliberately stale handle resets with 409, which is not claimed as a successful row read.

Authorization is deliberately a synthetic repository for this narrow URL experiment. It does not prove JWT, SQL grants, deployed proxy limits, full UI integration or production timing. Those remain separate gates.
