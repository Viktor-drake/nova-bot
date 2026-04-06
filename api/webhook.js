const { sendMessage, sendTyping } = require("../lib/telegram");
const { converse } = require("../lib/ai");
const { getCommunitySnapshot, notion, DB } = require("../lib/notion");

// --- Admin chat IDs (who can use admin commands like /find_matches) ---
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

// --- Base system prompt for Nova ---
const SYSTEM_PROMPT_BASE = `Ты — Nova, AI-ассистент бизнес-сообщества NextGen Club.

Твоя главная задача — находить связки между участниками сообщества:
- Если пользователь ищет ресурс/услугу/специалиста — найди подходящего человека из базы ниже
- Если есть подходящий участник — назови имя, telegram, что у него есть, и почему он подходит
- Если ничего не нашлось — честно скажи "сейчас в базе нет, попробуй спросить в чате клуба или у @Viktor_Drake"

КРИТИЧЕСКИ ВАЖНО — точность данных:
- Цитируй описания ресурсов из базы ДОСЛОВНО, в кавычках
- НИКОГДА не объединяй два названия в одно — перечисляй отдельно
- НИКОГДА не перефразируй и не сокращай названия — копируй буквально
- Если в поле "Детали" есть уточнения — приводи их как есть
- Лучше сказать "не уверен, проверь у @Viktor_Drake" чем выдумать факт

Стиль:
- Дружелюбный, но конкретный
- Без воды
- Имена и @username обязательно при совпадении
- Русский, на "ты"

Никогда не выдумывай людей, ресурсы или контакты — только из базы ниже.`;

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
  const text = (message.text || "").trim();
  console.log(`[Nova] msg=${message.message_id} chat=${chatId} text="${text.slice(0, 60)}"`);

  try {
    // --- Commands ---
    if (text === "/start") {
      await sendMessage(
        chatId,
        `Привет! Я *Nova* — AI-ассистент NextGen Club.\n\nЧто умею:\n• Найти нужного человека в сообществе\n• Подобрать ресурс или специалиста\n• Помочь с бизнес-задачей\n• Найти связки между участниками\n\nКоманды:\n/help — справка\n/find_matches — найти все потенциальные связки (админ)\n/my_deals — мои сделки (админ)\n\nПросто напиши свой вопрос!`
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/help") {
      await sendMessage(
        chatId,
        `*Команды:*\n/start — начать\n/help — справка\n/find_matches — найти связки (админ)\n/my_deals — мои сделки (админ)\n\n*Или просто напиши вопрос:*\n• "Найди студию для подкаста в Питере"\n• "Нужен маркетолог"\n• "Кто делает мебель?"`
      );
      return res.status(200).json({ ok: true });
    }

    // --- Admin: find matches ---
    if (text === "/find_matches") {
      if (ADMIN_CHAT_IDS.length && !ADMIN_CHAT_IDS.includes(String(chatId))) {
        await sendMessage(chatId, "Эта команда только для администратора.");
        return res.status(200).json({ ok: true });
      }
      await sendMessage(chatId, "🔍 Запускаю поиск связок... Это займёт 20-40 секунд.");
      // Respond to Vercel immediately, run matcher in background
      res.status(200).json({ ok: true, triggered: "find_matches" });

      try {
        // Invoke find-matches handler inline
        const findHandler = require("./find-matches");
        const fakeReq = { method: "POST", query: { secret: process.env.API_SECRET }, headers: {} };
        const fakeRes = {
          _status: 200,
          _body: null,
          status(s) { this._status = s; return this; },
          json(b) { this._body = b; return this; },
        };
        await findHandler(fakeReq, fakeRes);
        const result = fakeRes._body;

        if (result?.ok) {
          const list = (result.matches || []).map((m, i) => `${i + 1}. ${m}`).join("\n");
          await sendMessage(
            chatId,
            `✅ Поиск завершён за ${Math.round(result.ms / 1000)}с\n\nНайдено: ${result.found}\nЗаписано в Notion: ${result.written}\nПропущено: ${result.skipped}\n\n*Матчи:*\n${list || "(пусто)"}\n\nОткрой базу "🔗 Матчи" в Notion чтобы увидеть детали.`
          );
        } else {
          await sendMessage(chatId, `❌ Ошибка матчинга: ${result?.error || "unknown"}`);
        }
      } catch (e) {
        await sendMessage(chatId, `❌ Ошибка: ${e.message}`);
      }
      return;
    }

    // --- Admin: my deals ---
    if (text === "/my_deals") {
      if (ADMIN_CHAT_IDS.length && !ADMIN_CHAT_IDS.includes(String(chatId))) {
        await sendMessage(chatId, "Эта команда только для администратора.");
        return res.status(200).json({ ok: true });
      }
      try {
        const results = await notion.databases.query({
          database_id: DB.matches,
          filter: {
            property: "Я познакомил",
            checkbox: { equals: true },
          },
          page_size: 50,
        });

        let totalIncome = 0;
        let totalDeals = 0;
        const byStatus = {};
        const lines = [];

        for (const page of results.results) {
          const props = page.properties;
          const title = props["Суть матча"]?.title?.map((t) => t.plain_text).join("") || "Без названия";
          const status = props["Статус"]?.select?.name || "—";
          const amount = props["Сумма сделки"]?.number || 0;
          const percent = props["Мой процент %"]?.number || 0;
          const income = (amount * percent) / 100;

          byStatus[status] = (byStatus[status] || 0) + 1;
          if (status === "Состоялся" || status === "Сделка закрыта") {
            totalIncome += income;
            totalDeals += 1;
          }

          lines.push(
            `• ${title}\n  ${status}${amount ? ` · ${amount.toLocaleString("ru-RU")} ₽` : ""}${percent ? ` · ${percent}% = ${income.toLocaleString("ru-RU")} ₽` : ""}`
          );
        }

        const statusSummary = Object.entries(byStatus)
          .map(([s, n]) => `${s}: ${n}`)
          .join(" · ");

        const msg = results.results.length
          ? `💼 *Мои сделки* (${results.results.length})\n\n${statusSummary}\n\nЗакрыто: ${totalDeals} на ${totalIncome.toLocaleString("ru-RU")} ₽\n\n${lines.slice(0, 20).join("\n\n")}`
          : "Пока нет сделок где ты отмечен как 'Я познакомил'. Открой базу 🔗 Матчи в Notion и отметь галочкой те матчи, где ты свёл людей.";

        await sendMessage(chatId, msg);
      } catch (e) {
        await sendMessage(chatId, `❌ Ошибка: ${e.message}`);
      }
      return res.status(200).json({ ok: true });
    }

    // --- Voice placeholder ---
    if (message.voice || message.audio) {
      await sendMessage(chatId, "Голосовые пока в разработке. Напиши текстом.");
      return res.status(200).json({ ok: true });
    }

    const userText = text || (message.caption || "").trim();
    if (!userText) {
      return res.status(200).json({ ok: true });
    }

    sendTyping(chatId).catch(() => {});

    // Load community snapshot
    const t0 = Date.now();
    let snapshot = "";
    try {
      snapshot = await getCommunitySnapshot();
      console.log(`[Nova] snapshot ${Date.now() - t0}ms (${snapshot.length} chars)`);
    } catch (e) {
      console.warn(`[Nova] snapshot failed: ${e.message}`);
    }

    const systemPrompt = snapshot
      ? `${SYSTEM_PROMPT_BASE}\n\n=== БАЗА УЧАСТНИКОВ СООБЩЕСТВА ===\n${snapshot}\n=== КОНЕЦ БАЗЫ ===\n\nИспользуй ТОЛЬКО эту базу.`
      : SYSTEM_PROMPT_BASE;

    console.log(`[Nova] calling OpenRouter, prompt=${systemPrompt.length} chars`);
    const t1 = Date.now();
    const reply = await converse(
      systemPrompt,
      [],
      userText,
      { model: "anthropic/claude-haiku-4-5", maxTokens: 1000 }
    );
    console.log(`[Nova] AI ${Date.now() - t1}ms, len=${reply.length}`);

    const t2 = Date.now();
    await sendMessage(chatId, reply);
    console.log(`[Nova] sent ${Date.now() - t2}ms`);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`[Nova] ERROR: ${error.message}`);
    try {
      await sendMessage(chatId, "Произошла ошибка. Попробуй ещё раз.");
    } catch (_) {}
    return res.status(200).json({ ok: false, error: error.message });
  }
};
