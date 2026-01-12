import { addSubscriber, removeSubscriber, getSubscribers, fetchEvents, formatMessage } from "../lib/polymarket.js";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    from?: {
      username?: string;
      first_name?: string;
    };
    text?: string;
  };
}

async function sendMessage(chatId: number, text: string, markdown = false): Promise<void> {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(markdown && { parse_mode: "MarkdownV2", disable_web_page_preview: true }),
    }),
  });
}

async function sendLatestMarkets(chatId: number): Promise<void> {
  const events = await fetchEvents(10);
  for (const event of events.reverse()) {
    await sendMessage(chatId, formatMessage(event), true);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function POST(request: Request) {
  try {
    const update: TelegramUpdate = await request.json();
    const message = update.message;

    if (!message) {
      return Response.json({ ok: true });
    }

    const chatId = message.chat.id;
    const username = message.from?.username;
    const firstName = message.from?.first_name;
    const text = message.text?.trim().toLowerCase() || "";

    if (text === "/start") {
      const isNew = await addSubscriber(chatId, username, firstName);
      if (isNew) {
        await sendMessage(
          chatId,
          "🎉 Welcome! You're now subscribed to Polymarket new market alerts.\n\n" +
            "You'll receive notifications whenever new prediction markets are created.\n\n" +
            "Commands:\n" +
            "/stop - Unsubscribe from alerts\n" +
            "/status - Check subscription status\n\n" +
            "Here are the 10 latest markets:"
        );
        await sendLatestMarkets(chatId);
      } else {
        await sendMessage(chatId, "✅ You're already subscribed! Use /stop to unsubscribe.");
      }
    } else if (text === "/stop") {
      const removed = await removeSubscriber(chatId);
      if (removed) {
        await sendMessage(chatId, "👋 You've been unsubscribed. Use /start to subscribe again.");
      } else {
        await sendMessage(chatId, "ℹ️ You weren't subscribed. Use /start to subscribe.");
      }
    } else if (text === "/status") {
      const subscribers = await getSubscribers();
      const isSubscribed = subscribers.some((s) => s.chatId === chatId);
      if (isSubscribed) {
        await sendMessage(
          chatId,
          `✅ You're subscribed to Polymarket alerts.\n\n📊 Total subscribers: ${subscribers.length}`
        );
      } else {
        await sendMessage(chatId, "❌ You're not subscribed. Use /start to subscribe.");
      }
    } else {
      // Any other message - auto-subscribe
      const subscribers = await getSubscribers();
      const isSubscribed = subscribers.some((s) => s.chatId === chatId);
      if (!isSubscribed) {
        await addSubscriber(chatId, username, firstName);
        await sendMessage(
          chatId,
          "🎉 You're now subscribed to Polymarket new market alerts!\n\n" +
            "Commands:\n" +
            "/stop - Unsubscribe\n" +
            "/status - Check status"
        );
      }
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return Response.json({ ok: true }); // Always return 200 to Telegram
  }
}
