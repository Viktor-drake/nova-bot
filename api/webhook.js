const { sendMessage, sendTyping } = require("../lib/telegram");
const { converse } = require("../lib/ai");
const { getCommunitySnapshot } = require("../lib/notion");

// --- Base system prompt for Nova ---
const SYSTEM_PROMPT_BASE = `Ты — Nova, AI-ассистент бизнес-сообщества NextGen Club.

Твоя главная задача — находить связки между участниками сообщества:
- Если пользователь ищет ресурс/услугу/специалиста — найди подходящего человека из базы ниже
- Если есть подходящий участник — назови имя, telegram, что у него есть, и почему он подходит
- Если ничего не нашлось — честно скажи "сейчас в базе нет, попробуй спросить в чате клуба или у @Viktor_Drake"

КРИТИЧЕСКИ ВАЖНО — точность данных:
- Цитируй описания ресурсов из базы ДОСЛОВНО, в кавычках
- НИКОГДА не объединяй два названия в одно (например "Антикафе X" и "Студия Y" — это РАЗНЫЕ ресурсы, перечисляй отдельно)
- НИКОГДА не перефразируй и не сокращай названия — копируй буквально
- Если в поле "Детали" есть уточнения — приводи их как есть, не интерпретируй
- Лучше сказать "не уверен, проверь у @Viktor_Drake" чем выдумать факт

Стиль:
- Дружелюбный, но конкретный
- Без воды
- Имена людей и @username — обязательно когда есть совпадение
- Эмодзи умеренно
- Русский язык, на "ты"

Никогда не выдумывай людей, ресурсы или контакты — используй только данные из базы ниже. Если данных не хватает — так и скажи.`;

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
  console.log(`[Nova] msg=${message.message_id} text="${(message.text || "").slice(0, 60)}"`);

  try {
    if (message.text === "/start") {
      await sendMessage(chatId, `Привет! Я *Nova* — AI-ассистент NextGen Club.\n\nЯ могу:\n- Найти нужного человека в сообществе\n- Подобрать ресурс или специалиста\n- Помочь с бизнес-задачей\n\nПросто напиши свой вопрос!`);
      return res.status(200).json({ ok: true });
    }

    if (message.text === "/help") {
      await sendMessage(chatId, `*Что я умею:*\n\n/start — начать\n/help — справка\n\nИли просто напиши вопрос — я найду людей и решения в сообществе.`);
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

    sendTyping(chatId).catch(() => {});

    // Load community snapshot in parallel with the AI call setup
    const t0 = Date.now();
    let snapshot = "";
    try {
      snapshot = await getCommunitySnapshot();
      console.log(`[Nova] snapshot loaded in ${Date.now() - t0}ms (${snapshot.length} chars)`);
    } catch (e) {
      console.warn(`[Nova] snapshot failed: ${e.message}`);
    }

    const systemPrompt = snapshot
      ? `${SYSTEM_PROMPT_BASE}\n\n=== БАЗА УЧАСТНИКОВ СООБЩЕСТВА ===\n${snapshot}\n=== КОНЕЦ БАЗЫ ===\n\nИспользуй ТОЛЬКО эту базу для рекомендаций конкретных людей.`
      : SYSTEM_PROMPT_BASE;

    console.log(`[Nova] calling OpenRouter, prompt=${systemPrompt.length} chars`);
    const t1 = Date.now();
    const reply = await converse(
      systemPrompt,
      [],
      userText,
      { model: "anthropic/claude-haiku-4-5", maxTokens: 800 }
    );
    console.log(`[Nova] AI replied in ${Date.now() - t1}ms, len=${reply.length}`);

    const t2 = Date.now();
    await sendMessage(chatId, reply);
    console.log(`[Nova] sent to TG in ${Date.now() - t2}ms`);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`[Nova] ERROR: ${error.message}`);
    try {
      await sendMessage(chatId, "Произошла ошибка. Попробуй ещё раз.");
    } catch (_) {}
    return res.status(200).json({ ok: false, error: error.message });
  }
};
