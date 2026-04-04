const { sendMessage, sendTyping } = require("../lib/telegram");
const { converse } = require("../lib/ai");
const {
  findParticipantByChatId,
  saveMessage,
  getRecentMessages,
  getParticipantProfile,
} = require("../lib/notion");

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
- Никогда не раскрывай конфиденциальные данные других участников (блок потребностей скрыт)
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
  // Only accept POST
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, method: req.method });
  }

  // Verify Telegram secret
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.API_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const update = req.body;

  // Handle callback queries (button presses)
  if (update.callback_query) {
    // TODO: handle button callbacks
    return res.status(200).json({ ok: true });
  }

  const message = update.message;
  if (!message) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  const messageId = message.message_id;

  // Dedup
  if (isDuplicate(messageId)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  try {
    // Handle /start command
    if (message.text === "/start") {
      await sendMessage(
        chatId,
        `Привет! Я *Nova* — AI-ассистент NextGen Club.\n\nЯ могу:\n- Найти нужного человека в сообществе\n- Помочь с бизнес-задачей\n- Подсказать инструмент\n\nПросто напиши свой вопрос!`
      );
      return res.status(200).json({ ok: true });
    }

    // Handle /help command
    if (message.text === "/help") {
      await sendMessage(
        chatId,
        `*Что я умею:*\n\n/start — начать\n/profile — твой профиль\n/help — эта справка\n\nИли просто напиши вопрос — я отвечу.`
      );
      return res.status(200).json({ ok: true });
    }

    // Get user text (or caption for photos)
    let userText = message.text || message.caption || "";

    // Handle voice messages (placeholder — Whisper will be added later)
    if (message.voice || message.audio) {
      await sendMessage(
        chatId,
        "Голосовые сообщения пока в разработке. Напиши текстом, пожалуйста."
      );
      return res.status(200).json({ ok: true });
    }

    // Skip empty messages
    if (!userText.trim()) {
      return res.status(200).json({ ok: true });
    }

    // Show "typing..." while processing
    await sendTyping(chatId);

    // Find participant in Notion
    const participant = await findParticipantByChatId(chatId);

    // Build system prompt with participant context
    let systemPrompt = SYSTEM_PROMPT;
    if (participant) {
      const profile = await getParticipantProfile(participant);
      systemPrompt += `\n\n--- Профиль текущего участника ---\n${profile}`;
    } else {
      systemPrompt += `\n\nЭтот пользователь НЕ зарегистрирован в сообществе (chat_id: ${chatId}). Предложи связаться с @Viktor_Drake для регистрации.`;
    }

    // Handle /profile command
    if (userText === "/profile") {
      if (participant) {
        const profile = await getParticipantProfile(participant);
        await sendMessage(chatId, `*Твой профиль:*\n\n${profile}`);
      } else {
        await sendMessage(
          chatId,
          "Ты ещё не зарегистрирован. Свяжись с @Viktor_Drake для регистрации."
        );
      }
      return res.status(200).json({ ok: true });
    }

    // Load conversation history
    const history = await getRecentMessages(chatId, 20);

    // Save user message
    await saveMessage(chatId, "user", userText, participant?.id);

    // Call AI
    const reply = await converse(systemPrompt, history, userText);

    // Save assistant reply
    await saveMessage(chatId, "assistant", reply, participant?.id);

    // Send reply to user
    await sendMessage(chatId, reply);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);

    // Try to notify user about error
    try {
      await sendMessage(
        chatId,
        "Произошла ошибка. Попробуй ещё раз через минуту."
      );
    } catch (_) {}

    return res.status(200).json({ ok: false, error: error.message });
  }
};
