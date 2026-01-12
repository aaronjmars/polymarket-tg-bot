import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Types
export interface PolymarketMarket {
  question: string;
  outcomePrices: string;
  outcomes: string;
  volume: string;
  liquidity: string;
  volume24hr: number;
  volume1wk: number;
  volume1mo: number;
  startDate: string;
  endDate: string;
}

export interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  volume: string;
  liquidity: string;
  startDate: string;
  endDate: string;
  creationDate: string;
  resolutionSource: string;
  commentCount: number;
  new: boolean;
  featured: boolean;
  restricted: boolean;
  markets: PolymarketMarket[];
}

export interface Subscriber {
  chatId: number;
  username?: string;
  firstName?: string;
  subscribedAt: string;
}

// KV Keys
const LAST_SEEN_ID_KEY = "polymarket:lastSeenId";
const SUBSCRIBERS_KEY = "polymarket:subscribers";

// State management with Vercel KV
export async function getLastSeenId(): Promise<number> {
  const id = await redis.get<number>(LAST_SEEN_ID_KEY);
  return id || 0;
}

export async function setLastSeenId(id: number): Promise<void> {
  await redis.set(LAST_SEEN_ID_KEY, id);
}

export async function getSubscribers(): Promise<Subscriber[]> {
  const subscribers = await redis.get<Subscriber[]>(SUBSCRIBERS_KEY);
  return subscribers || [];
}

export async function addSubscriber(
  chatId: number,
  username?: string,
  firstName?: string
): Promise<boolean> {
  const subscribers = await getSubscribers();
  const exists = subscribers.some((s) => s.chatId === chatId);
  if (exists) return false;

  subscribers.push({
    chatId,
    username,
    firstName,
    subscribedAt: new Date().toISOString(),
  });
  await redis.set(SUBSCRIBERS_KEY, subscribers);
  return true;
}

export async function removeSubscriber(chatId: number): Promise<boolean> {
  const subscribers = await getSubscribers();
  const index = subscribers.findIndex((s) => s.chatId === chatId);
  if (index === -1) return false;

  subscribers.splice(index, 1);
  await redis.set(SUBSCRIBERS_KEY, subscribers);
  return true;
}

export async function removeSubscribers(chatIds: number[]): Promise<void> {
  if (chatIds.length === 0) return;
  const subscribers = await getSubscribers();
  const filtered = subscribers.filter((s) => !chatIds.includes(s.chatId));
  await redis.set(SUBSCRIBERS_KEY, filtered);
}

// Polymarket API
const GAMMA_API = "https://gamma-api.polymarket.com";

// Filter out spam/noise markets
function filterEvents(events: PolymarketEvent[]): PolymarketEvent[] {
  return events.filter((e) => {
    const title = e.title.toLowerCase();
    // Filter out "Up or Down" price prediction markets
    if (title.includes("up or down")) return false;
    return true;
  });
}

async function fetchEventsRaw(limit: number): Promise<PolymarketEvent[]> {
  const url = `${GAMMA_API}/events?order=id&ascending=false&closed=false&limit=${limit}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function fetchEvents(limit: number = 10): Promise<PolymarketEvent[]> {
  // Fetch more to account for filtered results
  const events = await fetchEventsRaw(limit * 5);
  return filterEvents(events).slice(0, limit);
}

export async function fetchNewEvents(): Promise<PolymarketEvent[]> {
  const lastSeenId = await getLastSeenId();
  // Fetch more raw events to find new ones after filtering
  const events = await fetchEventsRaw(100);

  return filterEvents(events)
    .filter((e) => parseInt(e.id) > lastSeenId)
    .reverse();
}

// Helper to escape MarkdownV2 special characters
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

// Format currency
function formatCurrency(value: string | number): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num) || num === 0) return "$0";
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

// Format date
function formatDate(dateStr: string): string {
  if (!dateStr) return "N/A";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

// Message formatting
export function formatMessage(event: PolymarketEvent): string {
  const url = `https://polymarket.com/event/${event.slug}`;
  const market = event.markets?.[0];

  // Title
  const escapedTitle = escapeMarkdown(event.title);

  // Outcomes and prices
  let outcomesText = "";
  if (market?.outcomePrices && market?.outcomes) {
    try {
      const prices = JSON.parse(market.outcomePrices);
      const outcomes = JSON.parse(market.outcomes);
      const outcomeLines = outcomes.map((outcome: string, i: number) => {
        const price = prices[i] ? (parseFloat(prices[i]) * 100).toFixed(1) : "0";
        return `  • ${escapeMarkdown(outcome)}: ${price}%`;
      });
      outcomesText = `\n📊 *Outcomes:*\n${outcomeLines.join("\n")}`;
    } catch {
      // Skip if parsing fails
    }
  }

  // Volume & Liquidity
  const volume = formatCurrency(event.volume);
  const liquidity = formatCurrency(event.liquidity);
  const volume24h = market?.volume24hr ? formatCurrency(market.volume24hr) : null;

  // Dates
  const endDate = formatDate(event.endDate);
  const createdDate = formatDate(event.creationDate);

  // Description (truncate if too long)
  let description = event.description || "";
  if (description.length > 300) {
    description = description.substring(0, 297) + "...";
  }
  const escapedDesc = escapeMarkdown(description);

  // Resolution source
  const resolutionSource = event.resolutionSource
    ? `\n🔍 *Resolution:* ${escapeMarkdown(event.resolutionSource)}`
    : "";

  // Tags
  const tags = [];
  if (event.new) tags.push("🆕 New");
  if (event.featured) tags.push("⭐ Featured");
  if (event.restricted) tags.push("🔒 Restricted");
  const tagsText = tags.length > 0 ? `\n${tags.join(" • ")}` : "";

  // Build message
  return `🆕 *NEW MARKET*\n\n` +
    `*${escapedTitle}*\n\n` +
    `📝 ${escapedDesc}\n` +
    outcomesText + `\n\n` +
    `💰 *Volume:* ${escapeMarkdown(volume)}\n` +
    `💧 *Liquidity:* ${escapeMarkdown(liquidity)}\n` +
    (volume24h ? `📈 *24h Volume:* ${escapeMarkdown(volume24h)}\n` : "") +
    `\n📅 *Created:* ${escapeMarkdown(createdDate)}\n` +
    `⏰ *End Date:* ${escapeMarkdown(endDate)}` +
    resolutionSource +
    tagsText + `\n\n` +
    `🔗 [View on Polymarket](${url})`;
}
