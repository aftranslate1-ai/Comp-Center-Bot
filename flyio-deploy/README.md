# Comp Center Bot — Fly.io Deployment

A Telegram bot for music file management, MP3 tagging, and premium subscriptions.

## Prerequisites

- [Fly.io account](https://fly.io) (free tier works)
- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installed
- A PostgreSQL database (Fly Postgres or any external Postgres)

## Deploy Steps

### 1. Clone / push to GitHub

Push this folder to a GitHub repository.

### 2. Create the Fly app

```bash
fly launch --no-deploy
```

When asked if you want to copy the existing `fly.toml`, say **yes**.  
Pick a unique app name and region.

### 3. Create a Postgres database

```bash
fly postgres create --name comp-center-bot-db
fly postgres attach comp-center-bot-db
```

This automatically sets `DATABASE_URL` as a secret.

### 4. Set the remaining secrets

```bash
fly secrets set TELEGRAM_BOT_TOKEN=your_token_here
fly secrets set TELEGRAM_API_ID=your_api_id
fly secrets set TELEGRAM_API_HASH=your_api_hash
```

### 5. Push your database schema

Run this once locally (with `DATABASE_URL` set in `.env`):

```bash
npm run db:push
```

Or after deploy, run it via:

```bash
fly ssh console -C "node -e \"require('./db/schema')\""
```

### 6. Deploy

```bash
fly deploy
```

## Environment Variables

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_API_ID` | From my.telegram.org |
| `TELEGRAM_API_HASH` | From my.telegram.org |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | HTTP port (set automatically by Fly) |

## Keeping it running

The `fly.toml` sets `auto_stop_machines = "off"` and `min_machines_running = 1` so the bot is always on.

## Logs

```bash
fly logs
```
