# Independent runtime review

The operations implementer reviewed the projection role, service, transport and fixture launcher independently. Final source rereview cleared packaging after the effective table/function audits were added, with the runtime limitations below preserved.

Resolved source findings:

- An idle pool error previously stopped the loop with exit status zero. It now exits nonzero; an isolated child-process fault test verifies the status and omission of connection error details.
- `SET ROLE` alone did not establish that the original login was constrained. The connection now verifies safe login attributes, exactly one non-admin projection membership, no direct table privileges, and no other accessible non-trigger security-definer functions. The role installer makes the same table/function checks. Actual read-only catalog checks pass for the fixture login.
- Transport previously left TLS verification implicit. Production now requires a verified DNS hostname and rejects weak SSL options. Only the exact owned loopback fixture configuration permits plaintext.

Nine focused tests pass after these changes. The active image and live browser receipts precede these fixes and remain identified as such. A source test is not a substitute for rebuilding and testing the image.

Unresolved release requirements: the independent fixture launcher has no automatic restart policy; transient database errors stop the worker and durable claims may wait up to 300 seconds. The final combined process must preserve separate action/projection pools, supervise both loops, prove crash/restart and stale-claim recovery, and fit the single 1 CPU / 1 GiB worker allocation. The action owner's signed-runtime proof and combined-image work are separate from this package. First1k admission does not establish the120k browser SLO.
