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
  the window go in the export under `reference` only (ids, statuses and, for the classifier comparison, message bodies; plus Jev production runs and later human decisions).
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

## Jev -> Luna fallback cascade evaluation (`replay:compare`)

Question: when Jev is not confident enough to auto-apply (its call is under the per-outcome
threshold, so today it goes to a human hold), would a second model, "Luna", have resolved those
holds correctly? Luna is an OpenAI model used as a classifier. It exists ONLY in this local
comparison. Nothing under `src/` references it (a unit test enforces that) and it is not wired
into any production path.

```bash
# Export first (the export now also carries Jev's production runs and later human decisions,
# plus outbound message bodies for context). Re-export if your file predates this section.
npm run replay:export -- --db-url "$SOURCE_DB_URL" --days 30 --batch 2026-10-07

# Only these keys in the shell. SENDILLO/TWILIO/DIALPAD keys make the script refuse to start.
export TYPESAFE_API_KEY=... OPENAI_API_KEY=... LUNA_MODEL=<model id>   # LUNA_MODEL has no default
# optional: LUNA_API=responses|chat (default responses), LUNA_TIMEOUT_MS,
#           LUNA_PRICE_INPUT_PER_MTOK + LUNA_PRICE_OUTPUT_PER_MTOK (USD per 1M tokens, enables cost)
npm run replay:compare -- --batch 2026-10-07 --concurrency 4
#   --head-to-head   also run Luna on EVERY message (default: only on Jev's holds)
#   --scope all_holds       cascade also covers policy holds (dnc, unclear, automation off); default below_threshold
#   --eligibility any       let Luna apply any thresholdable outcome (default: only outcomes Jev policy auto-applies)
#   --limit N               first N inbound
```

Output: `tmp/replay/compare-<batch>.report.md` and `.json` (mode 600; contains masked message text,
treat as seller PII). Message text is sent to TypeSafe and OpenAI, so it is masked but not anonymous:
names a seller typed inside a message are still in it. Results are cached in
`tmp/replay/compare-<batch>.jsonl`; a rerun makes no new paid calls for anything already answered
(changing the Luna model, API, prompt, or a message's thread invalidates only that entry; errors are
never cached, so they are retried).

### What is compared

1. **Jev alone (baseline):** Jev runs on each inbound with the same two-way thread production sends
   (last 15 messages plus the new text). The org's thresholds decide: at or above, auto-applied;
   below, held for a human. Thresholds come from `jev_outcome_thresholds` in the export; if the export
   has none, the Q5 defaults are used and the report says so (not_interested 0.90, wrong_number 0.90,
   nurture 0.95, opted_out 0.95, new_lead automation off).
2. **Cascade:** Jev's below-threshold holds go to Luna. Luna's call is applied only if its own
   confidence is at or above a cutoff (swept 0.80 to 0.99) AND the outcome is one Jev policy would
   auto-apply for this org (so Luna never auto-applies dnc, unclear, bad_number or an off outcome);
   everything else stays with the human. Per cutoff, overall and per Luna outcome: holds resolved,
   agreement with the human on exactly that subset, remaining human holds, and the **key risk
   number**: cases the cascade would get wrong that Jev alone would have sent to a human. The report
   also shows how often Jev's own below-threshold label was right on the same set.
3. **Head-to-head (`--head-to-head`):** per-outcome precision, recall and agreement, confusion matrix,
   and agreement at each confidence cutoff for both models on all messages with a human decision.

### Ground truth (what counts as "the human decided")

Reuses the Phase 3 scorecard's definition of agreed/corrected (`fn_messages_v2_scorecard`), turned
into the human's label. Per inbound text, first match, all within 72 hours of the text:

1. a corrected `ai_disposition_reviews` row: the corrected disposition (explicit)
2. a corrected `jev_lead_decisions` row: its resolved outcome (explicit)
3. a human `dispo_set` that differs from Jev's disposition: that disposition (explicit).
   `nurture` then `needs_sequence` is not an override (nurture is a parking step); `needs_sequence`
   is folded into `nurture`. With no Jev review/decision at all, the first human `dispo_set` is the label.
4. a human-confirmed review or decision: Jev's label (explicit)
5. auto-applied, at least 72 hours old at export time, never corrected: Jev's label (**implicit**,
   silence is not a decision)

Any other human disposition becomes the label `other` and can never match a Jev outcome. Messages
with no human decision are excluded from every score (they still count toward volume). The headline
tables use **explicit** decisions only; a second section adds implicit agreement. Sample sizes
(total, human-decided, cascade population, scored cascade cases) lead the report, and it warns when
fewer than 30 cascade cases are scored.

### Limits to read before trusting a number

- Luna's confidence is self-reported by the model, not Jev's native calibrated score. A cutoff of
  0.95 means different things for the two. Treat the sweep as a way to find where Luna's own numbers
  start to hold up, then verify on a fresh batch.
- Production thresholds changed over the window (Q5 landed 2026-10-08), but truth does not depend on
  thresholds, so it stays valid; the hold/auto split in the replay uses today's thresholds.
- Context fidelity: outbound bodies inside the window exist only in exports made after this section
  landed; the report counts messages whose context lacks them.
- Luna's prompt (`scripts/messages-v2/replay/luna-prompt.md`) is a **draft, not approved**. Every
  outcome and escalation-reason definition is copied verbatim from `src/lib/sms-classification/questions.ts`;
  the few connecting sentences are listed in that file and in the PR for approval. Regenerate with
  `npm run replay:luna-prompt`; a test fails if the file drifts from the code.

### Safety

The compare script opens no database connection and has no SMS code path. It refuses to start if
`SENDILLO_API_KEY`, `TWILIO_AUTH_TOKEN` or `DIALPAD_API_KEY` is set, or if any Supabase/Postgres URL in
the environment is production or non-local (same guards as the rest of the harness). `OPENAI_API_KEY`
is deliberately not blanked by `replay:server`'s `BLANKED_ENV`: the compare script runs standalone, never
through the replay server, so the server never receives it. No secret is written to any output.
