# Actual private fixture findings

- Initial installation guard refused the incomplete parsed trigger inventory. Its source regex omitted digits in `inbox_t2_policy`; the regex was corrected before installation. No tables changed on that refusal.
- First actual prepare failed with SQLSTATE 42702: PL/pgSQL `r` variable conflicted with the policy query's JSON alias. `setup-before-runtime-fix.sql` preserves the prior function, and `upgrade.py` required exact installed prior bodies before replacing functions. No tables were reset.
- The assignee-expiry fixture initially attempted to expire its final owner; canonical `FINAL_OWNER_GUARD` correctly rejected it. The fixture now inserts the requester owner first and a separate member assignee. No canonical guard was relaxed.
- The first property-baseline race attempted to toggle the immutable training marker. The test was changed to a legitimate soft-delete/restore on the run's own synthetic property and its property-identity counter. The training guard was not bypassed.

Final `behavior-evidence.json` records 7 passing actual preparation/acceptance/execution/status groups. `concurrency-evidence.json` records 4 passing actual two-connection waits. The overlap case demonstrates current revisions after a committed worker transaction; it does not yet demonstrate an actual deadlock victim retry. SQL trusted claims are not live HTTP authentication evidence.
