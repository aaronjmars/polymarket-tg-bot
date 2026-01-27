# Polymarket Telegram Bot

A Telegram bot that monitors [Polymarket](https://polymarket.com) and sends real-time notifications when new prediction markets are created.

## Features

- **Real-time alerts** - Get notified when new markets are created
- **Category filters** - Hide categories you're not interested in (Games, Sports, Politics, Culture, Finance, Crypto)
- **Spam filtering** - Automatically filters out noise like "Up or Down" price prediction markets
- **Auto-cleanup** - Removes inactive subscribers who blocked the bot

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Subscribe to alerts |
| `/stop` | Unsubscribe from alerts |
| `/status` | Check subscription status |
| `/filter` | Toggle category filters |

## Architecture

The bot supports two deployment modes:

### 1. Serverless (Vercel) - Recommended

Uses Vercel serverless functions with Upstash Redis for state management:

- `api/webhook.ts` - Handles Telegram webhook events (commands, button presses)
- `api/cron.ts` - Polls Polymarket API every minute for new markets
- `lib/polymarket.ts` - Shared utilities and Redis state management

### 2. Local/Self-hosted

Uses long-polling with file-based state:

- `src/bot.ts` - Standalone bot with polling and local file state (`.state.json`)

## Setup

### Prerequisites

- Node.js 18+
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- [Upstash Redis](https://upstash.com) account (for serverless deployment)
- [Vercel](https://vercel.com) account (for serverless deployment)

### 1. Clone and install

```bash
git clone <repo-url>
cd polymarket-telegram-bot
npm install
```

### 2. Configure environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description | Required |
|----------|-------------|----------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | Yes |
| `CRON_SECRET` | Random secret to secure the cron endpoint | Recommended |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL | Serverless only |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token | Serverless only |

### 3. Deploy to Vercel

```bash
npm i -g vercel
vercel
```

Set environment variables in Vercel dashboard or via CLI:

```bash
vercel env add TELEGRAM_BOT_TOKEN
vercel env add CRON_SECRET
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
```

### 4. Set up Telegram webhook

Replace `YOUR_BOT_TOKEN` and `YOUR_VERCEL_URL`:

```bash
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=YOUR_VERCEL_URL/api/webhook"
```

### Running locally (alternative)

For local development or self-hosting without Vercel:

```bash
# Development with hot reload
npm run dev

# Production
npm start
```

The local version uses file-based state and long-polling (no webhook required).

## How it works

1. **Cron job** runs every minute (`vercel.json` config)
2. Fetches latest events from Polymarket's Gamma API
3. Compares against last seen event ID stored in Redis
4. For each new event:
   - Formats the message with title, end date, and link
   - Broadcasts to all subscribers (respecting their category filters)
   - Updates the last seen ID
5. Automatically removes subscribers who have blocked the bot

## Tech Stack

- **TypeScript** - Type-safe JavaScript
- **[grammY](https://grammy.dev)** - Telegram Bot framework
- **[Upstash Redis](https://upstash.com)** - Serverless Redis for state
- **[Vercel](https://vercel.com)** - Serverless deployment with cron support

## License

MIT
