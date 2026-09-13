# Browser baseline status

The first browser attempt used the successful 55,000-conversation database
fixture's ordinary-member identity shape. The app redirected to `/login` before
rendering the Inbox. No UI latency is reported from that attempt.

Source inspection explains the fixture mismatch: Sandra middleware enforces the
allowed email domain and a fixed Sandra organization. The database-only baseline
used example.invalid and a separate random tenant, appropriate to its RLS reader
test but not to the actual UI entry contract.

Resolution: create new synthetic local owner/member fixtures matching the existing
UI access requirements, only in the exclusively owned local stack and only after
verifying that its Sandra organization has no existing application records. Do
not weaken authentication, reuse real user accounts, clear existing fixtures, or
treat the denied attempt as a product performance failure.

The local production build at port58760 uses only local Supabase configuration and
mock providers. Even a successful synthetic password-session browser run would
not prove genuine production Hugo SSO or real provider delivery.
