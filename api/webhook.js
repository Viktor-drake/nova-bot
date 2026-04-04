const { sendMessage, sendTyping } = require("../lib/telegram");
const { converse } = require("../lib/ai");

// --- System prompt for Nova ---
const SYSTEM_PROMPT = `Ты — Nova, AI-ассистент бизнес-сообщества NextGen Club.

Твоя роль:
- Помогать участникам находить нужных людей в сообществе
- Рекомендовать инструменты и решения для бизнес-задач
- Отвечать на вопросы о сообществе
- Помогать декомпозировать задачи

Стиль общения:
- Дружелюбный, но профессиональный
- Краткий и конкретный — не лей воду
- Используй эмодзи умеренно
- Отвечай на русском языке
- Обращайся на "ты"

Правила:
- Если участник не зарегистрирован — предложи связаться с администратором @Viktor_Drake
- Никогда не раскрывай конфиденциальные данные других участников
- Если не знаешь ответ — честно скажи и предложи обратиться к администратору`;

// --- Dedup: track processed message IDs ---
const processedMessages = new Set();
const MAX_PROCESSED = 1000;

function isDuplicate(messageId) {
  if (processedMessages.has(messageId)) return true;
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_PROCESSED) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }
  return false;
}

// --- Main webhook handler ---
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, method: req.method });
  }

  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.API_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const update = req.body;

  if (update.callback_query) {
    return res.status(200).json({ ok: true });
  }

  const message = update.message;
  if (!message) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  const messageId = message.message_id;

  if (isDuplicate(messageId)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  try {
    // --- /start ---
    if (message.text === "/start") {
      await sendMessage(
        chatId,
        `Привет! Я *Nova* — AI-ассистент NextGen Club.\n\nЯ могу:\n- Найти нужного человека в сообществе\n- Помочь с бизнес-задачей\n- Подсказать инструмент\n\nПросто напиши свой вопрос!`
      );
      return res.status(200).json({ ok: true });
    }

    // --- /help ---
    if (message.text === "/help") {
      await sendMessage(
        chatId,
        `*Что я умею:*\n\n/start — начать\n/help — эта справка\n\nИли просто напиши вопрос — я отвечу.`
      );
      return res.status(200).json({ ok: true });
    }

    // --- Voice placeholder ---
    if (message.voice || message.audio) {
      await sendMessage(
        chatId,
        "Голосовые сообщения пока в разработке. Напиши текстом."
      );
      return res.status(200).json({ ok: true });
    }

    const userText = (message.text || message.caption || "").trim();
    if (!userText) {
      return res.status(200).json({ ok: true });
    }

    // Show typing
    await sendTyping(chatId);

    // Call AI — NO Notion in the path, pure speed
    const reply = await converse(
      SYSTEM_PROMPT,
      [], // no history for now — keeps it fast
      userText,
      { model: "anthropic/claude-haiku-4-5", maxTokens: 800 }
    );

    // Send reply ASAP
    await sendMessage(chatId, reply);

    // Respond to Vercel immediately
    res.status(200).json({ ok: true });

    // --- Save to Notion in background (fire-and-forget) ---
    // This runs AFTER the response is sent, won't affect timeout
    try {
      const { saveMessage } = require("../lib/notion");
      await saveMessage(chatId, "user", userText);
      await saveMessage(chatId, "assistant", reply);
    } catch (e) {
      console.warn("Background Notion save failed:", e.message);
    }
  } catch (error) {
    console.error("Webhook error:", error);
    try {
      await sendMessage(chatId, "Произошла ошибка. Попробуй ещё раз.");
    } catch (_) {}
    return res.status(200).json({ ok: false, error: error.message });
  }
};
