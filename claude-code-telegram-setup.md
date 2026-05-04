# Claude Code Telegram Bridge: Install Plan

**Author:** Claude (for Jarrad)
**Date:** 2026-05-01
**Status:** Pre-install, awaiting go-ahead

---

## Goal

Control three live Claude Code sessions remotely from Telegram. One bot per project, one Telegram thread per session. No new tokens beyond what the sessions already use. Mac stays awake while sessions are running.

## Current state

Three Claude Code sessions running locally:

1. **Sandra** at `/Users/jarradhenry/Sites/Sandra` (currently: "Fix lead name capitalization in CRM")
2. **Closer Lab** at `/Users/jarradhenry/Sites/Closer Lab` (currently: "Resume dev server and fix git remotes")
3. **BMH Institute** (folder shows as "Sandra University" in the terminal title, but the actual project name is BMH Institute. Currently: "Optimize model selection with GSD Framework")

## Approach

Use Anthropic's official Claude Code Channels plugin. Released March 2026. Runs as a local MCP subprocess that bridges the Telegram Bot API into a running Claude Code session. Code never leaves the machine.

## Pieces involved

- **Telegram account** for Jarrad (must exist; created via Telegram app or web)
- **Bun runtime** installed on the Mac. The official plugin's MCP server runs on Bun. Install once: `curl -fsSL https://bun.sh/install | bash`.
- **Three Telegram bots** created through @BotFather. Each gets a unique token.
- **claude-plugins-official telegram plugin** installed once globally via `/plugin install telegram@claude-plugins-official` followed by `/reload-plugins`.
- **Three TELEGRAM_STATE_DIR directories**, one per project, so the bots do not share pairing/allowlist state: `~/.claude/channels/telegram-sandra`, `~/.claude/channels/telegram-closer-lab`, `~/.claude/channels/telegram-bmh-institute`.
- **Three Claude Code launches** with `--channels plugin:telegram@claude-plugins-official` and the matching `TELEGRAM_STATE_DIR` env var.
- **Pairing flow** per bot via `/telegram:access pair <code>` once Jarrad DMs each bot from his phone.
- **Lockdown step** per bot via `/telegram:access policy allowlist` so strangers cannot trigger pairing.
- **caffeinate** wrapping each session's launcher so the Mac does not sleep on them.

## Cost

Telegram bot API: $0. Plugin: $0. Hosting: $0 (runs on the Mac). Token usage: unchanged.

## Security posture

- Only paired Telegram user IDs can push messages; unauthorized messages are silently dropped.
- The `--channels` flag must be set explicitly every launch, so an unrelated session can never accidentally accept Telegram input.
- Each bot token will live in a per-project config file, not committed to git.

## Steps

**Phase A: prep work, no live sessions interrupted.**

1. Install Telegram on iPhone, create account.
2. Install Bun on the Mac: `curl -fsSL https://bun.sh/install | bash`.
3. Create Bot 1 via @BotFather for Sandra. Capture token.
4. Create Bot 2 for Closer Lab. Capture token.
5. Create Bot 3 for Sandra University. Capture token.
6. Install the official plugin once globally: `/plugin install telegram@claude-plugins-official` then `/reload-plugins` from any Claude Code session (a throwaway one is fine).
7. Pre-create the three state dirs and seed each `.env` with the matching bot token.

**Phase B: per-session, only when each one is at a clean stopping point.**

8. Sandra: exit current session, relaunch with `TELEGRAM_STATE_DIR=~/.claude/channels/telegram-sandra caffeinate -dimsu claude --channels plugin:telegram@claude-plugins-official`. DM the bot from the phone, capture pairing code, run `/telegram:access pair <code>`, then `/telegram:access policy allowlist`.
9. Closer Lab: same as 8 with `telegram-closer-lab`.
10. BMH Institute: same as 8 with `telegram-bmh-institute`.

**Phase C: verify.**

11. Round-trip test from phone for all three bots.

## Risks and rollback

- **Risk:** A bot token leaks. **Mitigation:** Rotate via @BotFather, takes 30 seconds.
- **Risk:** Pairing flow tied to wrong Telegram account. **Mitigation:** Pairing requires a code shown only in the local terminal, so impersonation is blocked.
- **Rollback:** Drop the `--channels` flag from any launch and the session is offline to Telegram. Revoke bot via @BotFather to fully kill it.

## Out of scope (for now)

- Slack bridge: revisit when official Anthropic Slack channel ships.
- iMessage: Mac-only option that landed a week after Telegram. Could add later if useful.
- Multiplexing all three sessions into a single Telegram thread: not how this plugin works.
