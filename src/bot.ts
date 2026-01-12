import { Bot } from "grammy";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { PolymarketEvent, BotState } from "./types.js";

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MINUTES || "5") * 60 * 1000;
const GAMMA_API = "https://gamma-api.polymarket.com";
const STATE_FILE = join(import.meta.dirname, "../.state.json");

// Validate required env vars
if (!TELEGRAM_TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("Error: TELEGRAM_CHAT_ID environment variable is required");
  process.exit(1);
}

// State management with file persistence
function loadState(): BotState {
  try {
    if (existsSync(STATE_FILE)) {
      const data = readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn("Could not load state file, starting fresh");
  }
  return { lastSeenId: 0 };
}

function saveState(state: BotState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to save state:", err);
  }
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
  const escapedTitle = event.title
    .replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");

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

  // Test bot connection
  try {
    const me = await bot.api.getMe();
    console.log(`✅ Connected as @${me.username}`);
  } catch (err) {
    console.error("Failed to connect to Telegram:", err);
    process.exit(1);
  }

  // Poll for new events
  async function poll() {
    try {
      const newEvents = await fetchNewEvents(state.lastSeenId);

      if (newEvents.length > 0) {
        console.log(`📢 Found ${newEvents.length} new event(s)`);
      }

      for (const event of newEvents) {
        try {
          await bot.api.sendMessage(CHAT_ID, formatMessage(event), {
            parse_mode: "MarkdownV2",
            link_preview_options: { is_disabled: true },
          });

          state.lastSeenId = Math.max(state.lastSeenId, parseInt(event.id));
          saveState(state);

          console.log(`✅ Posted: ${event.title} (ID: ${event.id})`);

          // Small delay between messages to avoid rate limits
          await new Promise((r) => setTimeout(r, 1000));
        } catch (err) {
          console.error(`Failed to post event ${event.id}:`, err);
        }
      }
    } catch (err) {
      console.error("Polling error:", err);
    }
  }

  // Initial poll
  await poll();

  // Set up interval
  console.log(`⏰ Polling every ${POLL_INTERVAL / 60000} minutes`);
  setInterval(poll, POLL_INTERVAL);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n👋 Shutting down...");
    saveState(state);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\n👋 Shutting down...");
    saveState(state);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
