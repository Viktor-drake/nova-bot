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
  const message = update.message;
  if (!message) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  console.log(`[Nova] msg=${message.message_id} text="${(message.text || "").slice(0, 50)}"`);

  try {
    // --- Commands ---
    if (message.text === "/start") {
      await sendMessage(chatId, `Привет! Я *Nova* — AI-ассистент NextGen Club.\n\nЯ могу:\n- Найти нужного человека в сообществе\n- Помочь с бизнес-задачей\n- Подсказать инструмент\n\nПросто напиши свой вопрос!`);
      return res.status(200).json({ ok: true });
    }

    if (message.text === "/help") {
      await sendMessage(chatId, `*Что я умею:*\n\n/start — начать\n/help — эта справка\n\nИли просто напиши вопрос — я отвечу.`);
      return res.status(200).json({ ok: true });
    }

    if (message.voice || message.audio) {
      await sendMessage(chatId, "Голосовые пока в разработке. Напиши текстом.");
      return res.status(200).json({ ok: true });
    }

    const userText = (message.text || message.caption || "").trim();
    if (!userText) {
      return res.status(200).json({ ok: true });
    }

    // Show typing
    sendTyping(chatId).catch(() => {});

    // Call AI
    console.log(`[Nova] calling OpenRouter...`);
    const t0 = Date.now();
    const reply = await converse(
      SYSTEM_PROMPT,
      [],
      userText,
      { model: "anthropic/claude-haiku-4-5", maxTokens: 600 }
    );
    console.log(`[Nova] AI replied in ${Date.now() - t0}ms, len=${reply.length}`);

    // Send reply
    const t1 = Date.now();
    await sendMessage(chatId, reply);
    console.log(`[Nova] sent to TG in ${Date.now() - t1}ms`);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`[Nova] ERROR: ${error.message}`);
    try {
      await sendMessage(chatId, "Произошла ошибка. Попробуй ещё раз.");
    } catch (_) {}
    return res.status(200).json({ ok: false, error: error.message });
  }
};
