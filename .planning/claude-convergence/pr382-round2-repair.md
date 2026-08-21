# PR #382 round-two repair evidence

- Base reviewed: `d26589245cc0d34c1828b10d71267321afac450f`
- Scope: implement the eight Fable rulings only; no merge or deploy.
- Rehearsal: `bash scripts/rehearse-leads-urgency-paging.sh` passed clean, including apply/replay and DNC assertions.
- Local verification: `pnpm run verify` passed (`218` files / `2285` unit tests; `81` files / `760` RTL tests).
- Focused verification: dialer, transport, state-machine, eligibility, migration-contract, and sweeper tests passed (`30` tests).
- Manual-DNC proof: exact `+18165550124` DNC lead returns `This number belongs to a DNC-locked lead`; no pause is written.
- Playwright: blocked before tests by missing `NEXT_PUBLIC_SUPABASE_URL` / anon key; the web server exits in middleware.
- Integration/replay of the new migration: blocked by missing `.env.test.local` / `TEST_SUPABASE_DB_URL`; Docker is unavailable for local Supabase.
- External review: required Sonnet lanes were unavailable in this runtime (`Unknown model sonnet`); no substitute reviewer was used. Fallow audit was run; no introduced unresolved-import, boundary, circular-dependency, or duplication findings remained.
