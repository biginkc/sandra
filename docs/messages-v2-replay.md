# Messages v2: 30-day production replay (sends impossible)

Watch `/messages-v2` process a month of real inbound SMS on your own machine.
Jev and Claude run for real. Nothing can reach Sendillo, and no real seller
phone number ever leaves production.

Phase 5 of `.planning/messages-v2/PLAN.md` (see 4.8b outbound gate, 4.9 kill switches).

## Quick start

Needs: a local Supabase stack with ALL migrations applied (including
`20261008180000_replay_harness.sql`), a Jev/TypeSafe key and an Anthropic key in
`.env.local`, and a read-only connection string for the source database.

```bash
export SUPABASE_LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres
export NODE_OPTIONS=--max-old-space-size=10240

# 1. Export (read-only, masks phones) -> tmp/replay/<batch>.json (gitignored)
npm run replay:export -- --db-url "$SOURCE_DB_URL" --days 30 --batch 2026-10-07

# 2. Seed the LOCAL database under a dedicated "Replay <batch>" org
npm run replay:seed -- --batch 2026-10-07 --owner-user <your-local-auth-user-uuid>

# 3. Start Sandra locally with the SMS stub on (leave running, port 3101)
npm run replay:server -- --batch 2026-10-07

# 4. Open http://localhost:3101/messages-v2 signed in as that owner, then replay
npm run replay:run -- --batch 2026-10-07 --speed 60 --max-gap-seconds 20
#   --speed 1     original pacing (30 days takes 30 days; use --since / --limit)
#   --speed 10    ten times faster
#   --burst       as fast as the pipeline accepts
#   --limit 50    first 50 inbound only      --since 2026-10-01T00:00:00Z

# 5. Clean up when done (removes the org and every row the replay created)
npm run replay:wipe -- --batch 2026-10-07
```

`replay:run` prints one line per inbound:

```
[012/340] msg=1f3a9c20 jev=nurture conf=0.93 gate=pass disp=auto outcome=sent ms=2410 orig=sent
```

and writes `tmp/replay/<batch>.summary.<run>.json`: counts per outcome, auto vs
held, gate-rule hits, p50/p95 latency per pipeline step (from
`pipeline_run_steps`), how many sends the stub swallowed, dead letters, and how
often the replay's final outcome matches what production actually did.

The `/messages-v2` header shows an amber **Replay batch <id>** badge for owners
of a replay org (it reads `replay_batches`; other orgs and non-owners never see it).

## Safety model

Each guarantee has a test. Run them all with `npm run test` (unit) and
`npm run test:integration:local` (real Postgres).

| Guarantee | How it is enforced | Where it is tested |
| --- | --- | --- |
| Harness only targets a localhost server | `assertLocalBaseUrl`: host must be exactly `localhost`, `127.0.0.1` or `[::1]`; no credentials in the URL; lookalikes (`localhost.evil.com`, `evil.com/@localhost`) refused. Runs before any request or query. | `safety.test.ts`, `run-core.test.ts` ("rejects a non-local base URL without making a single request or query") |
| Supabase target is never production | `assertSafeSupabaseUrl` / `assertSafeDbUrl`: any string containing the production ref (`copflsklaefwzipsrjqz`, plus refs found in `.env.production`, `.env.production.local`, `.vercel/.env.production.local`) is refused even with `--allow-project-ref`. Local stack is allowed; a hosted non-production project needs `--allow-project-ref <that exact ref>`. Unknown hosts refused. Empty ref list refuses (fail closed). DB URLs with `?host=` overrides refused. | `safety.test.ts`, `run-core.test.ts` |
| The stub flag cannot be set by accident in production | `isReplayStubEnabled` THROWS `ReplayStubConfigurationError` (never returns true, never silently stubs) when `SMS_PROVIDER_STUB=1` and any of: `VERCEL_ENV` is set, `NODE_ENV=production`, or the Supabase host is not loopback and not exactly `<REPLAY_ALLOW_PROJECT_REF>.supabase.co`. The error propagates through the registry, providers, rep-sms, the send pipeline and the handshake route (HTTP 500). A failed `replay_outbound_log` insert fails the stub send. | `replay-stub.test.ts`, `handshake/route.test.ts` |
| Nothing can reach Sendillo | `SMS_PROVIDER_STUB=1`. The real `SendilloMessagingProvider.sendSms` and catalog reads throw `ReplayStubError` before any `fetch`; the registry only hands out `SendilloReplayStubProvider`, which records the would-be send to `replay_outbound_log` and returns a fake receipt. Twilio/Dialpad `sendSms` and selection are refused; the bulk reply transport cannot be constructed. | `src/lib/messaging/replay-stub.test.ts` (real provider throws and never calls `fetch`; registry refusals; bulk transport) |
| Harness process holds no provider key | `assertHarnessEnv` refuses if `SENDILLO_API_KEY`, `TWILIO_AUTH_TOKEN` or `DIALPAD_API_KEY` is non-empty, and requires the stub flag. | `safety.test.ts`, `run-core.test.ts` |
| The SERVER is stubbed too | `GET /api/webhooks/replay/handshake` exists only when `SMS_PROVIDER_STUB=1` (404 otherwise). The runner refuses unless the server reports stub on, no Sendillo key, `AI_RESPONDER_LLM_AUTOSEND=0`, and the same Supabase host as the harness. Nothing is posted before this passes. `replay:server` also blanks vendor credentials and pins Supabase to the local stack. | `safety.test.ts` (`assertHandshake`), `run-core.test.ts` (no POST on any failed handshake), `server.test.ts`, `handshake/route.test.ts` |
| LLM drafts are held | Harness and server both force `AI_RESPONDER_LLM_AUTOSEND=0` (4.8b / D5). Template sends can still "send", but only into the stub. | `safety.test.ts`, `run-core.test.ts`, `server.test.ts` |
| Export never contains a real seller phone | Masked at export time (see below), then `assertNoRealPhones` walks the finished JSON and aborts the export if any phone-like string survives. | `mask.test.ts`, `export-core.test.ts`, `replay.integration.test.ts` |
| Export cannot write to the source | Runs in `begin transaction read only` + `statement_timeout`, always rolled back; only SELECTs are issued. | `export-core.test.ts` (SELECT-only, transaction shape), `replay.integration.test.ts` (Postgres rejects a write) |
| Seed cannot touch real data | Rows live under a dedicated org named `Replay <batch>`; seeding refuses if an exported id already exists in a non-replay org. Wipe is scoped to that org and refuses any org not named `Replay <batch>`. | `replay.integration.test.ts` |
| Everything is wipeable | Every seeded row is tagged in `replay_row_tags`; `--wipe` deletes the org's rows (including anything the replay run created), proves no tagged row remains, then drops the org and batch. | `replay.integration.test.ts` |

### PII in the export file (read this before sharing it)

Property addresses are exported unmasked (lead cards need them) and free-text
message bodies and notes are exported as written, so names mentioned inside a
message, or any other personal detail a seller typed, are still in the file.
Treat `tmp/replay/<batch>.json` as seller PII: it is written mode 600 to a
gitignored directory, never commit or upload it, and delete it (and run
`--wipe`) when the replay is done.

`replay:export` masks contact names (`first_name`, `last_name`, `entity_name`)
and email addresses deterministically by default (`--mask-pii`, on unless you
pass `--no-mask-pii`). Names become `First-<hash>` / `Last-<hash>` /
`Entity-<hash>`; emails inside text become `user-<hash>@example.invalid`. Names
and emails are not needed to exercise the pipeline, so there is little reason to
turn this off.

### Phone masking

Every seller phone becomes `+1<same area code>555<4 digits>`. The area code is
kept so quiet-hours and state logic still work. The 4-digit line is
`HMAC-SHA256(salt, real number)`, so it is deterministic but cannot be
brute-forced back; the salt is `REPLAY_MASK_SALT` or a random value stored once
in `tmp/replay/.mask-salt` (mode 600, gitignored).

Deliberate deviation from "use the 555-01XX fiction block": only 555-0100..0199
is formally reserved, which is 100 numbers per area code. Thousands of Kansas
City sellers would collide, and a collision merges two contacts and corrupts the
replay. We use the whole 555 exchange (10,000 lines per area code, collisions
resolved by probing so the mapping is one-to-one). 555 exchange numbers are not
assigned to subscribers, and the masked numbers are never dialled because sends
are stubbed.

Kept verbatim: addresses and message bodies. A phone number typed inside a
message body or note (for example "call me at 913-...") is also masked, because
"no real phone in the export" is the stricter requirement. That covers 10-digit
and +1 formats, 7-digit local numbers (replaced by a `555-xxxx` number),
international `+CC ...` numbers (replaced by `+1 555-xxxx`) and numeric phones
inside JSON. The final scan fails the export if any of these survive. Our own sender numbers (inbound `to`, outbound `from`) are
not seller phones and are kept as they are, since the thread matcher uses them.

## What is and is not replayed

- Replayed: every inbound SMS in the window, in original order, through the real
  Sendillo webhook route (`/api/webhooks/sendillo/sms`), so thread matching, STOP/DNC
  handling, Jev, thresholds, gates, holds and the evidence seam all run as in production.
- Seeded as history: SMS in the same threads from the 60 days (`--context-days`)
  BEFORE the window, so prior-outbound gate evidence exists. Messages inside the
  window are not seeded; the replay recreates them. Real outbound replies from
  the window go in the export under `reference` only (ids and statuses, no bodies).
- Also seeded: contacts, properties, property links, threads, suppressions,
  consent events, and the org's `ai_responder_configs` and `jev_outcome_thresholds`
  (when the target has those tables).
- `ai_responder_configs.reply_delay_*` are zeroed so runs finish promptly
  (`--keep-reply-delay` keeps them).

## Known limits

- Time-of-day logic (quiet hours, business hours) uses the wall clock of the replay, not the original receive time.
- The replay's duplicate-suppression keys are new per run, so you can replay the same export again without wiping, but outcomes then build on the earlier run's threads. Wipe and re-seed for a clean run.
- The export keeps the source's `ai_responder_configs.outbound_mode`; with the stub on, "send" mode sends only into `replay_outbound_log`.
- Alerts that Messages v2 Phase 1 raises (Slack DMs, email digests) use the local database's tokens; a fresh local database has none, so none fire. If you copy tokens in, they would fire.
- A hosted (non-local) test project is supported only with `--allow-project-ref`; the local stack is the tested path.
