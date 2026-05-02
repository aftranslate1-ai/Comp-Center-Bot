# Workspace

## Overview

pnpm workspace monorepo using TypeScript. A Telegram bot ("Comp Center Bot", @CompCenterBot) for music fans — search unreleased songs, tag MP3 files, premium subscriptions, and admin broadcasting.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Telegram Bot**: node-telegram-bot-api (polling mode)
- **MP3 tagging**: node-id3
- **Build**: esbuild (bundles to ESM)

## Telegram Bot

- **Entry point**: `artifacts/api-server/src/bot.ts`
- **Authorized admin**: @BeRichAsFreh (gates admin commands)
- **Bot username**: @CompCenterBot
- **Secrets**: `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET`, `TELEGRAM_API_HASH`, `TELEGRAM_API_ID`

## Commands (Public)

- `/start` — Welcome + premium settings if subscribed; handles `?start=get_<fileUniqueId>` deep links to download files
- `/search` — Search inline audio library by title/artist
- `/tagmp3` — Tag MP3 files: Normal mode (one file, custom title/artist/cover) or Fast mode (batch files, one cover + artist for all). 25 free tags/day, unlimited with premium. Strips track numbers and feat. credits from titles automatically.
- `/subscribe` — CC Premium (130 Telegram Stars/year): OG files, unlimited tagging, downloads, early music
- `/feedback` — Send complaint/request (forwarded to @complaintsrequests)

## Commands (Admin only — @BeRichAsFreh)

- `/publicforward` — Broadcast a message to selected channels. Audio gets a "Download ⬇️" button automatically, saved to bot_files for retrieval.
- `/publicfile` — Upload songs to inline search library (batched, progress every 5)
- `/removefile` — Remove songs: browse, search by name, or delete all
- `/publicearlymusic` — Send audio to all premium users with early music enabled
- `/freepremium` — Give or remove free lifetime premium from a user by @username or ID

## Database Tables

| Table | Purpose |
|---|---|
| `connected_chats` | Channels/groups the bot is in |
| `channel_messages` | Indexed audio from connected channels |
| `inline_audio_files` | Songs in inline search library |
| `bot_files` | Files saved for download via deep link |
| `users` | Premium status, early music flag, daily tag counts |
| `seen_leaked_threads` | Scraper dedup (leaked.cx, currently 403-blocked) |

## Premium System

- **130 Telegram Stars/year** via Telegram's native Stars invoice (`currency: XTR`)
- Premium features: download files, unlimited MP3 tagging, early music access, OG files
- Admin can grant free premium via `/freepremium` → notifies user automatically
- Early Music: premium users opt in to receive audio early via `/publicearlymusic`
- Cancel Subscription: keeps premium until expiry, no auto-renewal

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run typecheck:libs` — rebuild composite lib declarations
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
