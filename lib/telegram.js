const BOT_URL = () =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// --- Send text message ---
async function sendMessage(chatId, text, options = {}) {
  const { replyTo, keyboard } = options;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };
  if (replyTo) body.reply_to_message_id = replyTo;
  if (keyboard) {
    body.reply_markup = JSON.stringify({
      inline_keyboard: keyboard,
    });
  }

  const res = await fetch(`${BOT_URL()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
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
