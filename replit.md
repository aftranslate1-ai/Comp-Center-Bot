# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Includes a Telegram bot for Ava Max social media updates.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Telegram Bot**: node-telegram-bot-api (polling mode)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Telegram Bot

- **Entry point**: `artifacts/api-server/src/bot.ts`
- **DB schema**: `lib/db/src/schema/connectedChats.ts` — tracks groups/channels the bot is added to
- **Authorized user**: @BeRichAsFreh (only user who can use /publicforward)
- **Commands**:
  - `/start` — Welcome message with "Add to Group/Channel" button
  - `/publicforward` — (hidden, admin-only) Forward a message with optional URL buttons to all connected chats
- **Secrets**: `TELEGRAM_BOT_TOKEN`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
