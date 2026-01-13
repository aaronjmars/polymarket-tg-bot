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

export interface PolymarketTag {
  label: string;
  slug: string;
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
  tags: PolymarketTag[];
}

// Available filter categories
export const FILTER_CATEGORIES = [
  "Games",
  "Sports",
  "Politics",
  "Culture",
  "Finance",
  "Crypto",
] as const;

export type FilterCategory = (typeof FILTER_CATEGORIES)[number];

export interface Subscriber {
  chatId: number;
  username?: string;
  firstName?: string;
  subscribedAt: string;
  hiddenCategories?: FilterCategory[];
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

export async function getSubscriber(chatId: number): Promise<Subscriber | undefined> {
  const subscribers = await getSubscribers();
  return subscribers.find((s) => s.chatId === chatId);
}

export async function updateSubscriberFilters(
  chatId: number,
  hiddenCategories: FilterCategory[]
): Promise<boolean> {
  const subscribers = await getSubscribers();
  const index = subscribers.findIndex((s) => s.chatId === chatId);
  if (index === -1) return false;

  subscribers[index].hiddenCategories = hiddenCategories;
  await redis.set(SUBSCRIBERS_KEY, subscribers);
  return true;
}

// Check if an event should be shown to a subscriber based on their filters
export function shouldShowEvent(event: PolymarketEvent, hiddenCategories: FilterCategory[] = []): boolean {
  if (hiddenCategories.length === 0) return true;

  const eventTags = event.tags?.map((t) => t.label.toLowerCase()) || [];

  for (const category of hiddenCategories) {
    const categoryLower = category.toLowerCase();
    if (eventTags.some((tag) => tag.includes(categoryLower) || categoryLower.includes(tag))) {
      return false;
    }
  }

  return true;
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
  const escapedTitle = escapeMarkdown(event.title);
  const endDate = formatDate(event.endDate);

  return `🆕 *${escapedTitle}*\n\n` +
    `⏰ ${escapeMarkdown(endDate)}\n\n` +
    `🔗 [View on Polymarket](${url})`;
}
