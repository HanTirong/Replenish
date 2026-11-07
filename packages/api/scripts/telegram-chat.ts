// Run in Render Shell after setting TELEGRAM_BOT_TOKEN and before setting TELEGRAM_CHAT_ID.
// Prints only private chat IDs. Never print a token-bearing request URL or raw API errors.
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not configured in this environment."); process.exitCode = 1;
} else if (process.env.TELEGRAM_CHAT_ID?.trim()) {
  console.error("Chat ID is already configured. Stop the running Bot poller before using this setup helper."); process.exitCode = 1;
} else {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ limit: 100, timeout: 0, allowed_updates: ["message"] }),
    });
    const body = await response.json() as { ok?: boolean; result?: { message?: { chat?: { type?: string; id?: number } } }[] };
    if (!response.ok || !body?.ok || !Array.isArray(body.result)) throw new Error("Unavailable");
    const ids = [...new Set(body.result.flatMap(update => {
      const chat = update?.message?.chat;
      return chat?.type === "private" && Number.isSafeInteger(chat.id) && chat.id! > 0 ? [String(chat.id)] : [];
    }))];
    if (!ids.length) console.log("No private chat found. Send /start to your Bot, then run this helper again.");
    else for (const id of ids) console.log(`Private chat ID: ${id}`);
  } catch {
    console.error("Telegram setup lookup unavailable. Check configuration and ensure this Bot has no other poller or webhook."); process.exitCode = 1;
  }
}
export {};
