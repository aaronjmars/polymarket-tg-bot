import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Types
export interface PolymarketMarket {
  question: string;
  outcomePrices: string;
}

export interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  volume: string;
  liquidity: string;
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

export async function fetchEvents(limit: number = 10): Promise<PolymarketEvent[]> {
  const url = `${GAMMA_API}/events?order=id&ascending=false&closed=false&limit=${limit}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function fetchNewEvents(): Promise<PolymarketEvent[]> {
  const lastSeenId = await getLastSeenId();
  const events = await fetchEvents(20);

  return events
    .filter((e) => parseInt(e.id) > lastSeenId)
    .reverse();
}

// Message formatting
export function formatMessage(event: PolymarketEvent): string {
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

  const escapedTitle = event.title.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");

  return `🆕 *New Market*\n\n*${escapedTitle}*${pricesText}\n💰 Volume: ${volume}\n\n🔗 [View on Polymarket](${url})`;
}
