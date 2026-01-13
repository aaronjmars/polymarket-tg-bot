import {
  addSubscriber,
  removeSubscriber,
  getSubscribers,
  getSubscriber,
  updateSubscriberFilters,
  fetchEvents,
  formatMessage,
  FILTER_CATEGORIES,
  FilterCategory,
} from "../lib/polymarket.js";

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
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
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

function buildFilterKeyboard(hiddenCategories: FilterCategory[] = []) {
  const buttons = FILTER_CATEGORIES.map((category) => {
    const isHidden = hiddenCategories.includes(category);
    return [
      {
        text: `${isHidden ? "🔴" : "🟢"} ${category}`,
        callback_data: `filter:${category}`,
      },
    ];
  });
  return { inline_keyboard: buttons };
}

async function sendFilterMenu(chatId: number, hiddenCategories: FilterCategory[] = []): Promise<void> {
  const hiddenCount = hiddenCategories.length;
  const text =
    `⚙️ *Filter Settings*\n\n` +
    `Toggle categories to show/hide them from your alerts\\.\n\n` +
    `🟢 = Visible \\| 🔴 = Hidden\n\n` +
    `Currently hiding: ${hiddenCount === 0 ? "Nothing" : hiddenCount + " categories"}`;

  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      reply_markup: buildFilterKeyboard(hiddenCategories),
    }),
  });
}

async function updateFilterMenu(
  chatId: number,
  messageId: number,
  hiddenCategories: FilterCategory[] = []
): Promise<void> {
  const hiddenCount = hiddenCategories.length;
  const text =
    `⚙️ *Filter Settings*\n\n` +
    `Toggle categories to show/hide them from your alerts\\.\n\n` +
    `🟢 = Visible \\| 🔴 = Hidden\n\n` +
    `Currently hiding: ${hiddenCount === 0 ? "Nothing" : hiddenCount + " categories"}`;

  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "MarkdownV2",
      reply_markup: buildFilterKeyboard(hiddenCategories),
    }),
  });
}

async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
}

export async function POST(request: Request) {
  try {
    const update: TelegramUpdate = await request.json();

    // Handle callback queries (button presses)
    if (update.callback_query) {
      const { id, from, message, data } = update.callback_query;
      const chatId = message?.chat.id || from.id;
      const messageId = message?.message_id;

      if (data?.startsWith("filter:")) {
        const category = data.replace("filter:", "") as FilterCategory;
        const subscriber = await getSubscriber(chatId);

        if (!subscriber) {
          await answerCallbackQuery(id, "Please /start first to subscribe");
          return Response.json({ ok: true });
        }

        const currentHidden = subscriber.hiddenCategories || [];
        let newHidden: FilterCategory[];

        if (currentHidden.includes(category)) {
          newHidden = currentHidden.filter((c) => c !== category);
          await answerCallbackQuery(id, `${category} is now visible`);
        } else {
          newHidden = [...currentHidden, category];
          await answerCallbackQuery(id, `${category} is now hidden`);
        }

        await updateSubscriberFilters(chatId, newHidden);

        if (messageId) {
          await updateFilterMenu(chatId, messageId, newHidden);
        }
      }

      return Response.json({ ok: true });
    }

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
            "/status - Check subscription status\n" +
            "/filter - Filter market categories\n\n" +
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
      const subscriber = subscribers.find((s) => s.chatId === chatId);
      if (subscriber) {
        const hiddenCount = subscriber.hiddenCategories?.length || 0;
        const hiddenText = hiddenCount > 0
          ? `\n🔇 Hidden categories: ${subscriber.hiddenCategories?.join(", ")}`
          : "";
        await sendMessage(
          chatId,
          `✅ You're subscribed to Polymarket alerts.\n\n📊 Total subscribers: ${subscribers.length}${hiddenText}`
        );
      } else {
        await sendMessage(chatId, "❌ You're not subscribed. Use /start to subscribe.");
      }
    } else if (text === "/filter") {
      const subscriber = await getSubscriber(chatId);
      if (!subscriber) {
        await sendMessage(chatId, "❌ You're not subscribed. Use /start to subscribe first.");
        return Response.json({ ok: true });
      }
      await sendFilterMenu(chatId, subscriber.hiddenCategories);
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
            "/status - Check status\n" +
            "/filter - Filter categories"
        );
      }
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return Response.json({ ok: true }); // Always return 200 to Telegram
  }
}
