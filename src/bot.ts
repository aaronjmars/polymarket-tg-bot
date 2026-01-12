import { Bot } from "grammy";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { PolymarketEvent, BotState, Subscriber } from "./types.js";

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MINUTES || "5") * 60 * 1000;
const GAMMA_API = "https://gamma-api.polymarket.com";
const STATE_FILE = join(import.meta.dirname, "../.state.json");

// Validate required env vars
if (!TELEGRAM_TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

// State management with file persistence
function loadState(): BotState {
  try {
    if (existsSync(STATE_FILE)) {
      const data = readFileSync(STATE_FILE, "utf-8");
      const parsed = JSON.parse(data);
      // Ensure subscribers array exists (migration from old state)
      return {
        lastSeenId: parsed.lastSeenId || 0,
        subscribers: parsed.subscribers || [],
      };
    }
  } catch (err) {
    console.warn("Could not load state file, starting fresh");
  }
  return { lastSeenId: 0, subscribers: [] };
}

function saveState(state: BotState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to save state:", err);
  }
}

// Subscriber management
function addSubscriber(state: BotState, chatId: number, username?: string, firstName?: string): boolean {
  const exists = state.subscribers.some((s) => s.chatId === chatId);
  if (exists) return false;

  state.subscribers.push({
    chatId,
    username,
    firstName,
    subscribedAt: new Date().toISOString(),
  });
  saveState(state);
  return true;
}

function removeSubscriber(state: BotState, chatId: number): boolean {
  const index = state.subscribers.findIndex((s) => s.chatId === chatId);
  if (index === -1) return false;

  state.subscribers.splice(index, 1);
  saveState(state);
  return true;
}

// Fetch events from Polymarket API
async function fetchEvents(limit: number = 10): Promise<PolymarketEvent[]> {
  const url = `${GAMMA_API}/events?order=id&ascending=false&closed=false&limit=${limit}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

// Get new events since last seen ID
async function fetchNewEvents(lastSeenId: number): Promise<PolymarketEvent[]> {
  const events = await fetchEvents(20);

  return events
    .filter((e) => parseInt(e.id) > lastSeenId)
    .reverse(); // oldest first so we post in chronological order
}

// Format event for Telegram message
function formatMessage(event: PolymarketEvent): string {
  const url = `https://polymarket.com/event/${event.slug}`;
  const volume = parseFloat(event.volume || "0").toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  let pricesText = "";
  if (event.markets?.[0]?.outcomePrices) {
    try {
      const prices = JSON.parse(event.markets[0].outcomePrices);
      if (prices.length >= 2) {
        const yesPrice = (parseFloat(prices[0]) * 100).toFixed(0);
        const noPrice = (parseFloat(prices[1]) * 100).toFixed(0);
        pricesText = `\n📊 Yes: ${yesPrice}% / No: ${noPrice}%`;
      }
    } catch {
      // Skip prices if parsing fails
    }
  }

  // Escape special markdown characters in title
  const escapedTitle = event.title.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");

  return `🆕 *New Market*\n\n*${escapedTitle}*${pricesText}\n💰 Volume: ${volume}\n\n🔗 [View on Polymarket](${url})`;
}

// Main bot logic
async function main() {
  const bot = new Bot(TELEGRAM_TOKEN);
  let state = loadState();

  console.log("🤖 Polymarket Telegram Bot starting...");

  // If no previous state, initialize with latest event ID
  if (state.lastSeenId === 0) {
    try {
      const events = await fetchEvents(1);
      if (events.length > 0) {
        state.lastSeenId = parseInt(events[0].id);
        saveState(state);
        console.log(`📍 Initialized at event ID: ${state.lastSeenId}`);
      }
    } catch (err) {
      console.error("Failed to initialize:", err);
      process.exit(1);
    }
  } else {
    console.log(`📍 Resuming from event ID: ${state.lastSeenId}`);
  }

  console.log(`👥 ${state.subscribers.length} subscriber(s) loaded`);

  // Command handlers
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat.id;
    const username = ctx.from?.username;
    const firstName = ctx.from?.first_name;

    const isNew = addSubscriber(state, chatId, username, firstName);

    if (isNew) {
      console.log(`➕ New subscriber: ${username || firstName || chatId}`);
      await ctx.reply(
        "🎉 Welcome! You're now subscribed to Polymarket new market alerts.\n\n" +
          "You'll receive notifications whenever new prediction markets are created.\n\n" +
          "Commands:\n" +
          "/stop - Unsubscribe from alerts\n" +
          "/status - Check subscription status"
      );
    } else {
      await ctx.reply("✅ You're already subscribed! Use /stop to unsubscribe.");
    }
  });

  bot.command("stop", async (ctx) => {
    const chatId = ctx.chat.id;
    const removed = removeSubscriber(state, chatId);

    if (removed) {
      console.log(`➖ Unsubscribed: ${ctx.from?.username || ctx.from?.first_name || chatId}`);
      await ctx.reply("👋 You've been unsubscribed. Use /start to subscribe again.");
    } else {
      await ctx.reply("ℹ️ You weren't subscribed. Use /start to subscribe.");
    }
  });

  bot.command("status", async (ctx) => {
    const chatId = ctx.chat.id;
    const isSubscribed = state.subscribers.some((s) => s.chatId === chatId);

    if (isSubscribed) {
      await ctx.reply(
        `✅ You're subscribed to Polymarket alerts.\n\n` +
          `📊 Total subscribers: ${state.subscribers.length}\n` +
          `🔄 Polling interval: ${POLL_INTERVAL / 60000} minutes`
      );
    } else {
      await ctx.reply("❌ You're not subscribed. Use /start to subscribe.");
    }
  });

  // Handle any other message as a subscription request
  bot.on("message", async (ctx) => {
    const chatId = ctx.chat.id;
    const isSubscribed = state.subscribers.some((s) => s.chatId === chatId);

    if (!isSubscribed) {
      const username = ctx.from?.username;
      const firstName = ctx.from?.first_name;
      addSubscriber(state, chatId, username, firstName);
      console.log(`➕ New subscriber (via message): ${username || firstName || chatId}`);
      await ctx.reply(
        "🎉 You're now subscribed to Polymarket new market alerts!\n\n" +
          "Commands:\n" +
          "/stop - Unsubscribe\n" +
          "/status - Check status"
      );
    }
  });

  // Broadcast message to all subscribers
  async function broadcast(message: string): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;
    const failedChatIds: number[] = [];

    for (const subscriber of state.subscribers) {
      try {
        await bot.api.sendMessage(subscriber.chatId, message, {
          parse_mode: "MarkdownV2",
          link_preview_options: { is_disabled: true },
        });
        success++;
        // Small delay to avoid rate limits
        await new Promise((r) => setTimeout(r, 100));
      } catch (err: any) {
        failed++;
        // Remove subscriber if they blocked the bot or chat not found
        if (err.error_code === 403 || err.error_code === 400) {
          failedChatIds.push(subscriber.chatId);
          console.log(`🚫 Removing inactive subscriber: ${subscriber.chatId}`);
        } else {
          console.error(`Failed to send to ${subscriber.chatId}:`, err.message);
        }
      }
    }

    // Clean up inactive subscribers
    for (const chatId of failedChatIds) {
      removeSubscriber(state, chatId);
    }

    return { success, failed };
  }

  // Poll for new events
  async function poll() {
    if (state.subscribers.length === 0) {
      return; // No subscribers, skip polling
    }

    try {
      const newEvents = await fetchNewEvents(state.lastSeenId);

      if (newEvents.length > 0) {
        console.log(`📢 Found ${newEvents.length} new event(s), broadcasting to ${state.subscribers.length} subscriber(s)`);
      }

      for (const event of newEvents) {
        const { success, failed } = await broadcast(formatMessage(event));

        state.lastSeenId = Math.max(state.lastSeenId, parseInt(event.id));
        saveState(state);

        console.log(`✅ Broadcast: ${event.title} (ID: ${event.id}) - ${success} sent, ${failed} failed`);

        // Delay between events
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error("Polling error:", err);
    }
  }

  // Test bot connection
  try {
    const me = await bot.api.getMe();
    console.log(`✅ Connected as @${me.username}`);
  } catch (err) {
    console.error("Failed to connect to Telegram:", err);
    process.exit(1);
  }

  // Start the bot (listen for messages)
  bot.start({
    onStart: (botInfo) => {
      console.log(`🚀 Bot @${botInfo.username} is running`);
      console.log(`💬 Users can DM the bot to subscribe`);
    },
  });

  // Initial poll
  await poll();

  // Set up interval
  console.log(`⏰ Polling every ${POLL_INTERVAL / 60000} minutes`);
  setInterval(poll, POLL_INTERVAL);

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\n👋 Shutting down...");
    saveState(state);
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
