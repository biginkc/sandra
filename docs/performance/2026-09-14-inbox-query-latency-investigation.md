# Inbox query-latency investigation (/messages snapshot RPC) — 2026-09-14

## Problem
`sms_inbox_thread_page_snapshot` (the /messages inbox RPC) took ~1.5s and spilled ~164MB to temp at production scale, on a 2GB Supabase tier. Classification joins ~64k in-window conversations against full contacts(308k)/properties(184k) every load.

## Prod facts (read-only)
- messages 125,957; conversations 100,724; in-90-day-window 93,479; 1.22 msgs/conversation.
- Instance RAM ≈ 2GB; shared_buffers 512MB; work_mem 5MB; hash_mem_multiplier 2; max_connections 90; PostgREST pool ≈ 13-15 live.
- Safe work-memory budget A ≈ 0.25×(2GB−512MB) ≈ 384MB.

## Experiment matrix (1.0x-recent fixture, filter=unread, single-shot)
| variant | temp written | exec ms | verdict |
|---|---:|---:|---|
| OLD fn | ~164MB | 1,538 | baseline |
| #604 v1 hydration-defer | ~136MB | 1,000 | insufficient (full-table hash persists) |
| E1+E2 narrow keys + search projection | ~141MB | 940 | plan not flipped |
| E3 force nested-loop | ~206MB | 6,709 | 7x WORSE — index/NL is not the fix |
| E4 SET STATISTICS 1000 + ANALYZE | ~141MB | 978 | estimate fix doesn't flip plan |
| E5 semi-join prefilter (contacts/properties_in_window) | ~80MB | 1,176 | halves spill, not eliminated |
| E5 + work_mem 16MB | ~43MB | 981 | still spills |
| **E5 + work_mem 32MB** | **0** | **~800-994** | spill eliminated, Batches:1 |

## The wall
E5+32MB eliminates the disk spill by holding the previously-spilled ~48MB + hashes in RAM. Honest per-call working memory ≈ 80-100MB (hashes ~19MB + live AS MATERIALIZED tuplestores). At PostgREST pool ≈ 15: 15 × ~90MB ≈ 1.35GB >> 384MB safe budget on the 2GB tier → OOM risk. So the in-place spill-elimination is UNSAFE on this tier at real concurrency.

## Options
1. Lower work_mem so bounded spill returns — safe, partial speedup only.
2. Bump DB tier (more RAM) — makes E5+32MB safe; needs full gate finished.
3. /inbox redesign (precomputes classification; merged, flag-gated off) — only path to the approved budget; has Lane-4 rollout gates outstanding.

## Measurement caveats (for whoever continues)
- `docker stats MemUsage` is NOT per-query working memory (includes page cache) — do not use for Q. Use `pg_log_backend_memory_contexts(pid)` per-backend Grand total, or plan-reported Hash/Sort Memory Usage.
- Raw psql concurrency on a 2-CPU fixture is CPU-bound and cannot measure the spill's concurrency benefit — use the app-endpoint harness.
- Full rulings S1–S22 + Astra reviews: _codex_worktrees/sandra-pr521-stress/.planning/stress-test/pr521/FABLE-RULINGS.md; measured numbers in GATE-RESULTS.md there.

Related: PR #521 (merged, live — send/switch stability). PR #604 (draft — E5+32MB, unsafe on 2GB tier as-is).
