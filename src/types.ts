export interface PolymarketMarket {
  question: string;
  outcomePrices: string; // JSON array: '["0.65", "0.35"]'
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

export interface BotState {
  lastSeenId: number;
  subscribers: Subscriber[];
}
