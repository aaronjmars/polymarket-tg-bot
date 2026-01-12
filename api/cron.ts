import {
  fetchEvents,
  fetchNewEvents,
  formatMessage,
  getLastSeenId,
  setLastSeenId,
  getSubscribers,
  removeSubscribers,
} from "../lib/polymarket";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId: number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      // User blocked the bot or chat not found
      if (data.error_code === 403 || data.error_code === 400) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function broadcast(message: string): Promise<{ success: number; failed: number; toRemove: number[] }> {
  const subscribers = await getSubscribers();
  let success = 0;
  let failed = 0;
  const toRemove: number[] = [];

  for (const subscriber of subscribers) {
    const sent = await sendMessage(subscriber.chatId, message);
    if (sent) {
      success++;
    } else {
      failed++;
      toRemove.push(subscriber.chatId);
    }
    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 50));
  }

  return { success, failed, toRemove };
}

export async function GET(request: Request) {
  // Verify cron secret (optional but recommended)
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Allow if no CRON_SECRET is set (for easier testing)
    if (process.env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const subscribers = await getSubscribers();

    if (subscribers.length === 0) {
      return Response.json({ message: "No subscribers, skipping" });
    }

    // Initialize lastSeenId if needed
    let lastSeenId = await getLastSeenId();
    if (lastSeenId === 0) {
      const events = await fetchEvents(1);
      if (events.length > 0) {
        lastSeenId = parseInt(events[0].id);
        await setLastSeenId(lastSeenId);
        return Response.json({ message: "Initialized", lastSeenId });
      }
    }

    const newEvents = await fetchNewEvents();

    if (newEvents.length === 0) {
      return Response.json({ message: "No new events", lastSeenId });
    }

    const results = [];
    const allToRemove: number[] = [];

    for (const event of newEvents) {
      const message = formatMessage(event);
      const { success, failed, toRemove } = await broadcast(message);

      allToRemove.push(...toRemove);

      await setLastSeenId(Math.max(lastSeenId, parseInt(event.id)));
      lastSeenId = parseInt(event.id);

      results.push({
        eventId: event.id,
        title: event.title,
        success,
        failed,
      });

      // Delay between events
      await new Promise((r) => setTimeout(r, 500));
    }

    // Clean up inactive subscribers
    if (allToRemove.length > 0) {
      await removeSubscribers([...new Set(allToRemove)]);
    }

    return Response.json({
      message: "Broadcast complete",
      events: results,
      subscribersRemoved: allToRemove.length,
    });
  } catch (error) {
    console.error("Cron error:", error);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
