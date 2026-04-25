const { sendMessage, sendTyping, sendVoice } = require("../lib/telegram");
const { transcribeVoice } = require("../lib/voice");
const { synthesizeVoice } = require("../lib/tts");
const { converse, getLastUsage } = require("../lib/ai");
const {
  getCommunitySnapshot,
  notion,
  DB,
  findParticipantByChatId,
  ensureParticipantByChat,
  setParticipantMode,
  setParticipantVoiceOff,
  saveMessage,
  getRecentMessages,
  createResource,
  createNeed,
  updateParticipantProfile,
  prop,
} = require("../lib/notion");
const {
  chatAnketa,
  extractFromDialog,
  BUTTONS,
  novaKeyboard,
  anketaKeyboard,
} = require("../lib/anketa");
const {
  checkPerMessage,
  checkAndConsumeQuota,
  recordTokens,
  getModelMode,
  ensureRole,
} = require("../lib/limits");

// --- Admin chat IDs ---
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

// --- Base system prompt for Nova ---
const SYSTEM_PROMPT_BASE = `Ты — Nova, девушка-коннектор бизнес-сообщества NextGen Club. Ты ВСЕГДА говоришь о себе в женском роде ("я нашла", "я подумала", "сама посмотрела", "рада помочь"). Никогда не мужской род.

Стиль: тёплая, умная, чуть игривая и кокетливая. Можешь мягко подшутить, восхититься, поддразнить — но без липкости и без перебора эмодзи. Ты живая собеседница, а не корпоративный бот.

ГОЛОСОВЫЕ ВОЗМОЖНОСТИ (ОБЯЗАТЕЛЬНО ЗНАЙ):
Ты Nova — голосовой AI-ассистент. У тебя ЕСТЬ голос. Ты умеешь:
- Принимать голосовые сообщения (система расшифровывает их в текст автоматически)
- Отвечать голосом (система озвучивает твой текст голосом shimmer и отправляет как аудио)
Когда видишь вопрос пользователя — это уже расшифрованное голосовое. Твой текстовый ответ БУДЕТ озвучен и отправлен голосом автоматически.
АБСОЛЮТНО ЗАПРЕЩЕНО говорить: "я не умею голосом", "я только текстовая", "я не могу отвечать голосом", "это не моя функция", "TTS недоступен", "настрой голос" — всё это ЛОЖЬ. Ты уже отвечаешь голосом прямо сейчас. Просто говори по существу.
Кнопка "🔇 Голос: вкл/выкл" управляет голосом — если хочет отключить, пусть нажмёт.

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

Стиль: дружелюбный, конкретный, без воды, на "ты", по-русски.

Никогда не выдумывай людей, ресурсы или контакты — только из базы ниже.`;

// --- Helpers ---
function isButton(text) {
  return Object.values(BUTTONS).includes(text);
}

async function writeAnketaResults(participantId, parsed) {
  const stats = { resources: 0, needs: 0, profileUpdated: false };

  if (parsed.профиль) {
    try {
      await updateParticipantProfile(participantId, parsed.профиль);
      stats.profileUpdated = true;
    } catch (e) {
      console.warn(`[anketa] profile update failed: ${e.message}`);
    }
  }

  for (const r of parsed.ресурсы || []) {
    try {
      await createResource({ ownerId: participantId, ...r });
      stats.resources += 1;
    } catch (e) {
      console.warn(`[anketa] resource create failed: ${e.message} | ${JSON.stringify(r)}`);
    }
  }

  for (const n of parsed.потребности || []) {
    try {
      await createNeed({ authorId: participantId, ...n });
      stats.needs += 1;
    } catch (e) {
      console.warn(`[anketa] need create failed: ${e.message} | ${JSON.stringify(n)}`);
    }
  }

  return stats;
}

// --- Main handler ---
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true, method: req.method });

  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.API_SECRET) return res.status(403).json({ error: "Forbidden" });

  const update = req.body;
  const message = update.message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const rawText = (message.text || "").trim();
  const fromName = message.from?.first_name || message.from?.username || `Гость ${chatId}`;
  const fromHandle = message.from?.username || "";
  console.log(`[Nova] msg=${message.message_id} chat=${chatId} text="${rawText.slice(0, 60)}"`);

  // --- Per-message guard (anti-flood, длина, cooldown) ---
  // Применяется ко ВСЕМ входящим, кроме голосовых (для голоса работает квота)
  let text = rawText;
  if (rawText) {
    const guard = checkPerMessage(chatId, rawText);
    if (!guard.ok) {
      if (guard.reason) {
        try { await sendMessage(chatId, guard.reason); } catch (_) {}
      }
      return res.status(200).json({ ok: true, blocked: "guard" });
    }
    text = guard.text;
    if (guard.truncated) {
      try { await sendMessage(chatId, "⚠️ Сообщение длинноватое, я прочла первые 2000 символов."); } catch (_) {}
    }
  }

  try {
    // --- /start ---
    if (text === "/start") {
      const p = await ensureParticipantByChat(chatId, fromName, fromHandle);
      const isNew = prop(p, "Статус") !== "Активный";
      if (isNew) {
        await setParticipantMode(p.id, "anketa", "A. Кто ты");
        sendTyping(chatId).catch(() => {});
        const kickoffPrompt = "Старт анкеты. Поприветствуй тёплым тоном, представься как Nova — коннектор NextGen Club. Скажи, что поиск связок откроется сразу после заполнения профиля, и начни с первого вопроса блока А (имя, город).";
        const reply = await chatAnketa([], kickoffPrompt);
        await saveMessage(chatId, "assistant", reply, p.id);
        await sendMessage(chatId, reply, { replyKeyboard: anketaKeyboard(false) });
      } else {
        await sendMessage(
          chatId,
          `Привет! Я *Nova* — AI-ассистент NextGen Club.\n\nЯ помогу тебе:\n• Найти нужного человека или ресурс в сообществе\n• Подобрать связку, партнёра, эксперта\n• Заполнить твой профиль, чтобы тебя тоже находили\n\nВыбери внизу что хочешь делать. По умолчанию я в режиме поиска — просто пиши вопрос.`,
          { replyKeyboard: novaKeyboard(false) }
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (text === "/help") {
      await sendMessage(
        chatId,
        `Кнопки внизу:\n• 🧠 *Спросить Nova* — поиск людей, ресурсов, связок\n• 📝 *Заполнить / дополнить профиль* — анкета (15-20 мин), чтобы тебя могли находить\n\n/limits — мои лимиты\n\nАдмин-команды:\n/find_matches — прогнать матчинг\n/my_deals — мои сделки`,
        { replyKeyboard: novaKeyboard(false) }
      );
      return res.status(200).json({ ok: true });
    }

    // --- /limits ---
    if (text === "/limits") {
      const p = await findParticipantByChatId(chatId);
      if (!p) {
        await sendMessage(chatId, "Не нашла твой профиль. Напиши /start чтобы зарегистрироваться.");
        return res.status(200).json({ ok: true });
      }
      const role = p.properties?.["Роль"]?.select?.name || "Гость";
      const quota = { "Гость": { msgs: 200, voice: 60, tokens: 400_000 }, "Участник": { msgs: 200, voice: 60, tokens: 400_000 }, "VIP": { msgs: 500, voice: 150, tokens: 1_000_000 }, "Founder": { msgs: Infinity, voice: Infinity, tokens: Infinity } }[role] || { msgs: 200, voice: 60, tokens: 400_000 };
      const today = new Date().toISOString().slice(0, 10);
      const resetDate = p.properties?.quota_reset?.date?.start;
      const isToday = resetDate === today;
      const msgsUsed   = isToday ? (p.properties?.msgs_today?.number || 0) : 0;
      const voiceUsed  = isToday ? (p.properties?.voice_today?.number || 0) : 0;
      const tokensUsed = isToday ? (p.properties?.tokens_today?.number || 0) : 0;
      const fmtNum = (n) => isFinite(n) ? n.toLocaleString("ru-RU") : "∞";
      const bar = (used, total) => {
        if (!isFinite(total)) return "∞";
        const pct = Math.round(used / total * 10);
        return "█".repeat(pct) + "░".repeat(10 - pct) + ` ${used}/${fmtNum(total)}`;
      };
      await sendMessage(chatId,
        `📊 *Мои лимиты* — ${role}\n\n` +
        `💬 Сообщения\n${bar(msgsUsed, quota.msgs)}\n\n` +
        `🎤 Голосовые\n${bar(voiceUsed, quota.voice)}\n\n` +
        `🔤 Токены\n${bar(tokensUsed, quota.tokens)}\n\n` +
        `♻️ Сбросится: завтра в 00:00 UTC`
      );
      return res.status(200).json({ ok: true });
    }

    // --- Admin: find_matches ---
    if (text === "/find_matches") {
      if (ADMIN_CHAT_IDS.length && !ADMIN_CHAT_IDS.includes(String(chatId))) {
        await sendMessage(chatId, "Эта команда только для администратора.");
        return res.status(200).json({ ok: true });
      }
      await sendMessage(chatId, "🔍 Запускаю поиск связок... Это займёт 20-40 секунд, подожди.");
      try {
        const findHandler = require("./find-matches");
        const fakeReq = { method: "POST", query: { secret: process.env.API_SECRET }, headers: {} };
        let result = null;
        const fakeRes = { status() { return this; }, json(b) { result = b; return this; } };
        await findHandler(fakeReq, fakeRes);
        if (result?.ok) {
          const list = (result.matches || []).map((m, i) => `${i + 1}. ${m}`).join("\n");
          await sendMessage(
            chatId,
            `✅ Поиск завершён за ${Math.round(result.ms / 1000)}с\n\nНайдено: ${result.found}\nЗаписано в Notion: ${result.written}\nПропущено: ${result.skipped}\n\n*Матчи:*\n${list || "(пусто)"}\n\nОткрой базу "🔗 Матчи" в Notion.`
          );
        } else {
          await sendMessage(chatId, `❌ Ошибка матчинга: ${result?.error || "unknown"}`);
        }
      } catch (e) {
        console.error("[find_matches] error:", e.message);
        await sendMessage(chatId, `❌ Ошибка: ${e.message}`);
      }
      return res.status(200).json({ ok: true });
    }

    // --- Admin: my_deals ---
    if (text === "/my_deals") {
      if (ADMIN_CHAT_IDS.length && !ADMIN_CHAT_IDS.includes(String(chatId))) {
        await sendMessage(chatId, "Эта команда только для администратора.");
        return res.status(200).json({ ok: true });
      }
      try {
        const results = await notion.databases.query({
          database_id: DB.matches,
          filter: { property: "Я познакомил", checkbox: { equals: true } },
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
          lines.push(`• ${title}\n  ${status}${amount ? ` · ${amount.toLocaleString("ru-RU")} ₽` : ""}${percent ? ` · ${percent}% = ${income.toLocaleString("ru-RU")} ₽` : ""}`);
        }
        const statusSummary = Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(" · ");
        const msg = results.results.length
          ? `💼 *Мои сделки* (${results.results.length})\n\n${statusSummary}\n\nЗакрыто: ${totalDeals} на ${totalIncome.toLocaleString("ru-RU")} ₽\n\n${lines.slice(0, 20).join("\n\n")}`
          : "Пока нет сделок где ты отмечен как 'Я познакомил'. Открой базу 🔗 Матчи в Notion и отметь галочкой те матчи, где ты свёл людей.";
        await sendMessage(chatId, msg);
      } catch (e) {
        await sendMessage(chatId, `❌ Ошибка: ${e.message}`);
      }
      return res.status(200).json({ ok: true });
    }

    // --- Voice transcription ---
    let voiceText = null;
    if (message.voice || message.audio) {
      // Мгновенная реакция чтобы юзер видел что бот не завис
      const teasers = [
        "м-м, секунду, слушаю тебя 🤍",
        "так, дай пару секунд — записываю ответ голосом",
        "погоди, сейчас отвечу голосом",
        "ок, думаю над ответом, держись",
      ];
      sendMessage(chatId, teasers[Math.floor(Math.random() * teasers.length)]).catch(() => {});
      sendTyping(chatId).catch(() => {});
      try {
        const fileId = (message.voice || message.audio).file_id;
        voiceText = await transcribeVoice(fileId);
      } catch (e) {
        await sendMessage(chatId, `Не смог расшифровать голос: ${e.message}`);
        return res.status(200).json({ ok: true });
      }
    }

    const userText = voiceText || text || (message.caption || "").trim();
    if (!userText) return res.status(200).json({ ok: true });

    // --- Ensure participant + load mode ---
    let participant = await findParticipantByChatId(chatId);
    if (!participant) {
      participant = await ensureParticipantByChat(chatId, fromName, fromHandle);
    }
    // Дефолтная роль для новых — Гость (Founder/VIP проставляются вручную)
    ensureRole(participant, "Гость").catch(() => {});
    const currentMode = prop(participant, "Режим") || "nova";
    const profileComplete = prop(participant, "Статус") === "Активный";
    let voiceOff = !!prop(participant, "Голос выкл");
    const KB_NOVA = () => novaKeyboard(voiceOff);
    const KB_ANKETA = () => anketaKeyboard(voiceOff);
    const maybeVoice = async (text) => {
      // Глобальный downgrade месячного капа отключает TTS
      const mm = await getModelMode();
      if (voiceText && !voiceOff && mm.allowTTS) {
        try { await sendVoice(chatId, await synthesizeVoice(text)); return true; }
        catch (e) { console.error("[tts]", e.message); return false; }
      }
      return false;
    };
    // Если юзер прислал гс и голос вкл — отвечаем ТОЛЬКО голосом, без текста
    const respond = async (reply, kb) => {
      const voiced = await maybeVoice(reply);
      if (!voiced) await sendMessage(chatId, reply, { replyKeyboard: kb });
    };

    // --- Button: toggle voice ---
    if (userText === BUTTONS.VOICE_ON || userText === BUTTONS.VOICE_OFF) {
      voiceOff = !voiceOff;
      await setParticipantVoiceOff(participant.id, voiceOff);
      const kb = currentMode === "anketa" ? KB_ANKETA() : KB_NOVA();
      await sendMessage(
        chatId,
        voiceOff ? "🔇 Голос отключён. Буду отвечать только текстом." : "🔊 Голос включён. Запиши голосовое — отвечу голосом.",
        { replyKeyboard: kb }
      );
      return res.status(200).json({ ok: true });
    }

    // --- Button: switch to NOVA ---
    if (userText === BUTTONS.NOVA || userText === BUTTONS.BACK) {
      if (!profileComplete) {
        await sendMessage(
          chatId,
          "Поиск связок откроется после того, как заполнишь профиль. Давай продолжим — осталось немного 🙂",
          { replyKeyboard: KB_ANKETA() }
        );
        return res.status(200).json({ ok: true });
      }
      await setParticipantMode(participant.id, "nova", null);
      await sendMessage(
        chatId,
        "Окей, я в режиме поиска. Спроси что нужно — найду людей, ресурсы, связки.",
        { replyKeyboard: KB_NOVA() }
      );
      return res.status(200).json({ ok: true });
    }

    // --- Button: start/continue ANKETA ---
    if (userText === BUTTONS.ANKETA) {
      await setParticipantMode(participant.id, "anketa", "A. Кто ты");
      sendTyping(chatId).catch(() => {});
      // Reload participant for current data check
      const hasData = prop(participant, "Суперсила") || prop(participant, "Текущий проект");
      const kickoffPrompt = hasData
        ? "Привет снова! Что хочешь дополнить или обновить в профиле? Или давай я задам несколько уточняющих вопросов по слабым местам?"
        : "Старт анкеты. Поприветствуй меня тёплым тоном, объясни зачем мы это делаем, и задай первый вопрос блока А (имя, город).";
      const reply = await chatAnketa([], kickoffPrompt);
      await saveMessage(chatId, "assistant", reply, participant.id);
      await respond(reply, KB_ANKETA());
      return res.status(200).json({ ok: true });
    }

    // --- Button: FINISH anketa → extract & save ---
    if (userText === BUTTONS.FINISH) {
      if (currentMode !== "anketa") {
        await sendMessage(chatId, "Ты сейчас не в режиме анкеты. Нажми 📝 чтобы начать.", { replyKeyboard: KB_NOVA() });
        return res.status(200).json({ ok: true });
      }
      await sendMessage(chatId, "💾 Сохраняю и извлекаю данные... 20-40 секунд.");
      try {
        const history = await getRecentMessages(chatId, 100);
        if (!history.length) {
          await sendMessage(chatId, "Пока нечего сохранять — диалога анкеты ещё нет.", { replyKeyboard: KB_NOVA() });
          await setParticipantMode(participant.id, "nova", null);
          return res.status(200).json({ ok: true });
        }
        const parsed = await extractFromDialog(history);
        const stats = await writeAnketaResults(participant.id, parsed);

        // Activate participant if completeness ok
        const avg = parsed.completeness?.average ?? 0;
        const newStatus = avg >= 7 ? "Активный" : "Новый";
        await notion.pages.update({
          page_id: participant.id,
          properties: { Статус: { select: { name: newStatus } } },
        });

        await setParticipantMode(participant.id, "nova", null);

        const completenessLines = parsed.completeness
          ? Object.entries(parsed.completeness)
              .filter(([k]) => k !== "average")
              .map(([k, v]) => `  ${k.replace(/_/g, " ")}: ${v}/10`)
              .join("\n")
          : "";

        const summary = `✅ Сохранено!\n\n📦 Ресурсов: ${stats.resources}\n🎯 Потребностей: ${stats.needs}\n👤 Профиль обновлён: ${stats.profileUpdated ? "да" : "нет"}\n\n*Глубина по блокам:*\n${completenessLines}\nСредняя: ${avg}/10\n\nСтатус: ${newStatus}\n${avg < 7 ? "\n⚠️ Анкета поверхностная. Нажми 📝 ещё раз чтобы дозаполнить — без этого матчи будут слабые." : "\n🔥 Профиль готов для матчинга. Спроси меня что-то или жми /find_matches."}`;
        await sendMessage(chatId, summary, { replyKeyboard: KB_NOVA() });
      } catch (e) {
        console.error(`[anketa] finish error: ${e.message}`);
        await sendMessage(chatId, `❌ Ошибка при сохранении: ${e.message}\n\nДанные не потеряны — попробуй ещё раз через минуту.`);
      }
      return res.status(200).json({ ok: true });
    }

    // --- Quota check (только для AI-сообщений, не для кнопок/команд) ---
    const quotaKind = voiceText ? "voice" : "text";
    const quota = await checkAndConsumeQuota(participant, quotaKind);
    if (!quota.ok) {
      const kb = currentMode === "anketa" ? KB_ANKETA() : KB_NOVA();
      await sendMessage(chatId, quota.reason, { replyKeyboard: kb });
      return res.status(200).json({ ok: true, blocked: "quota" });
    }
    // Предупреждение 80% — отправляем тихо, не блокируем ответ
    if (quota.warning) {
      sendMessage(chatId, quota.warning).catch(() => {});
    }
    // Текущий режим модели с учётом месячного капа
    const modelMode = await getModelMode();
    if (modelMode.level !== "normal") {
      console.log(`[Nova] modelMode=${modelMode.level} (downgrade active)`);
    }

    // --- Mode router ---
    if (currentMode === "anketa") {
      sendTyping(chatId).catch(() => {});
      const t0 = Date.now();
      try {
        await saveMessage(chatId, "user", userText, participant.id);
      } catch (e) {
        console.warn(`[anketa] save user msg failed: ${e.message}`);
      }
      const history = await getRecentMessages(chatId, 50);
      // history already includes the user msg we just saved; remove last to avoid duplicate
      const histForAi = history.slice(0, -1);
      console.log(`[anketa] history=${histForAi.length} msgs, calling Sonnet`);
      const reply = await chatAnketa(histForAi, userText);
      console.log(`[anketa] AI ${Date.now() - t0}ms, len=${reply.length}`);
      const u = getLastUsage();
      recordTokens(participant, u.input, u.output, u.model).catch(() => {});
      try {
        await saveMessage(chatId, "assistant", reply, participant.id);
      } catch (e) {
        console.warn(`[anketa] save assistant msg failed: ${e.message}`);
      }
      await respond(reply, KB_ANKETA());
      return res.status(200).json({ ok: true });
    }

    // --- Default mode: NOVA ---
    // Блокируем nova пока профиль не заполнен
    if (!profileComplete) {
      if (currentMode !== "anketa") {
        await setParticipantMode(participant.id, "anketa", "A. Кто ты");
      }
      await sendMessage(
        chatId,
        "Чтобы я могла искать тебе связки — сначала заполним профиль. Напиши что-нибудь или нажми *📝 Заполнить профиль* — и начнём.",
        { replyKeyboard: KB_ANKETA() }
      );
      return res.status(200).json({ ok: true });
    }

    // --- Проверка лимита поиска для Гостей ---
    const searchQuota = await checkAndConsumeQuota(participant, "search");
    if (!searchQuota.ok) {
      await sendMessage(chatId, searchQuota.reason, { replyKeyboard: KB_NOVA() });
      return res.status(200).json({ ok: true, blocked: "search_quota" });
    }
    if (searchQuota.warning) {
      sendMessage(chatId, searchQuota.warning).catch(() => {});
    }

    sendTyping(chatId).catch(() => {});
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

    // Для голосовых — короткий ответ (быстрее TTS, меньше шанс таймаута)
    const maxTokens = voiceText ? 400 : 1000;

    const t1 = Date.now();
    const reply = await converse(systemPrompt, [], userText, {
      model: modelMode.model,
      maxTokens,
    });
    console.log(`[Nova] AI ${Date.now() - t1}ms, len=${reply.length}`);
    const u = getLastUsage();
    recordTokens(participant, u.input, u.output, u.model).catch(() => {});

    await respond(reply, KB_NOVA());
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`[Nova] ERROR: ${error.message}\nStack: ${error.stack?.slice(0,500)}`);
    try {
      await sendMessage(chatId, "Произошла ошибка. Попробуй ещё раз.");
    } catch (_) {}
    return res.status(200).json({ ok: false, error: error.message });
  }
};
