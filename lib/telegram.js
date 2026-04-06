const BOT_URL = () =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// --- Send text message (with Markdown → plain fallback) ---
async function sendMessage(chatId, text, options = {}) {
  const { replyTo, keyboard, replyKeyboard, removeKeyboard, parseMode = "Markdown" } = options;

  const buildBody = (mode) => {
    const body = { chat_id: chatId, text };
    if (mode) body.parse_mode = mode;
    if (replyTo) body.reply_to_message_id = replyTo;
    if (keyboard) {
      body.reply_markup = JSON.stringify({ inline_keyboard: keyboard });
    } else if (replyKeyboard) {
      body.reply_markup = JSON.stringify({
        keyboard: replyKeyboard,
        resize_keyboard: true,
        is_persistent: true,
      });
    } else if (removeKeyboard) {
      body.reply_markup = JSON.stringify({ remove_keyboard: true });
    }
    return body;
  };

  // Attempt 1: with Markdown
  let res = await fetch(`${BOT_URL()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(parseMode)),
  });
  let data = await res.json();

  // Attempt 2: fallback to plain text if Markdown parse failed
  if (!data.ok && data.description?.includes("parse")) {
    console.warn(`[telegram] Markdown failed, retrying plain: ${data.description}`);
    res = await fetch(`${BOT_URL()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(null)),
    });
    data = await res.json();
  }

  if (!data.ok) {
    throw new Error(`Telegram sendMessage failed: ${data.description || JSON.stringify(data)}`);
  }
  return data;
}

// --- Send "typing..." indicator ---
async function sendTyping(chatId) {
  await fetch(`${BOT_URL()}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

// --- Download file from Telegram ---
async function downloadFile(fileId) {
  const fileRes = await fetch(`${BOT_URL()}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const fileData = await fileRes.json();
  if (!fileData.ok) throw new Error("Failed to get file path");

  const filePath = fileData.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

  const response = await fetch(fileUrl);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    path: filePath,
  };
}

// --- Set webhook URL ---
async function setWebhook(url, secret) {
  const res = await fetch(`${BOT_URL()}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
    }),
  });
  return res.json();
}

module.exports = { sendMessage, sendTyping, downloadFile, setWebhook };
