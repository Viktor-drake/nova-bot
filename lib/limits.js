// Лимиты Новы — защита от спама и сжигания токенов.
//
// Три уровня защиты:
//   1. Per-message guards (длина, anti-flood) — мгновенная, in-memory
//   2. Per-user квоты (сообщения / голос / токены в сутки) — Notion
//   3. Глобальный месячный кап ($) — Notion (cold start safe) + in-memory кэш
//
// Роли (поле "Роль" в Notion):
//   - Гость       — 100 текста/день, 30 голоса/день, 10 поисков/месяц
//   - Участник    — 200 текста/день, 60 голоса/день, поиск ∞
//   - VIP         — 500 текста/день, 150 голоса/день, поиск ∞
//   - Founder     — без лимитов

const { notion, loadMonthSpend, saveMonthSpend } = require("./notion");

const MAX_INPUT_LEN = 2000;
const FLOOD_WINDOW_MS = 30_000;
const FLOOD_MAX_MSGS = 5;
const FLOOD_COOLDOWN_MS = 60_000;
const MIN_INTERVAL_MS = 1500;

const QUOTAS = {
  "Гость":    { msgs: 100, voice: 30,  tokens: 200_000, searchesMonth: 10  },
  "Участник": { msgs: 200, voice: 60,  tokens: 400_000, searchesMonth: Infinity },
  "VIP":      { msgs: 500, voice: 150, tokens: 1_000_000, searchesMonth: Infinity },
  "Founder":  { msgs: Infinity, voice: Infinity, tokens: Infinity, searchesMonth: Infinity },
};

const MONTH_CAP_USD = parseFloat(process.env.NOVA_MONTH_CAP_USD || "40");
const MONTH_WARN_USD = MONTH_CAP_USD * 0.7;
const MONTH_NO_TTS_USD = MONTH_CAP_USD * 0.85;

// --- In-memory state ---
const floodState = new Map();
const monthState = { spentUsd: 0, monthKey: monthKey(), loaded: false };

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Загружаем monthState из Notion один раз при первом обращении (cold start fix)
let _loadingPromise = null;
async function ensureMonthStateLoaded() {
  if (monthState.loaded) return;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    const { spentUsd, monthKey: savedKey } = await loadMonthSpend();
    const current = monthKey();
    if (savedKey === current) {
      monthState.spentUsd = spentUsd;
    } else {
      monthState.spentUsd = 0; // новый месяц
    }
    monthState.monthKey = current;
    monthState.loaded = true;
    console.log(`[limits] monthState loaded from Notion: $${monthState.spentUsd.toFixed(4)} (${monthState.monthKey})`);
  })().catch((e) => {
    console.warn("[limits] failed to load monthState:", e.message);
    monthState.loaded = true; // не ретраим, работаем с 0
  });
  return _loadingPromise;
}

function getRole(participant) {
  return participant?.properties?.["Роль"]?.select?.name || "Гость";
}

function getCounter(participant, fieldName) {
  return participant?.properties?.[fieldName]?.number || 0;
}

function getResetDate(participant) {
  return participant?.properties?.quota_reset?.date?.start || null;
}

function getSearchesMonth(participant) {
  return participant?.properties?.searches_month?.number || 0;
}

function getSearchesMonthKey(participant) {
  return participant?.properties?.searches_month_key?.rich_text?.map(t => t.plain_text).join("") || null;
}

// --- Public: per-message guards (синхронно, без Notion) ---
function checkPerMessage(chatId, rawText) {
  const now = Date.now();
  let st = floodState.get(chatId);
  if (!st) {
    st = { lastTs: 0, msgs: [], cooldownUntil: 0 };
    floodState.set(chatId, st);
  }

  if (st.cooldownUntil > now) {
    const sec = Math.ceil((st.cooldownUntil - now) / 1000);
    return { ok: false, reason: `⏸ Слишком много сообщений подряд. Подожди ${sec} сек и продолжим 🤍` };
  }

  if (st.lastTs && now - st.lastTs < MIN_INTERVAL_MS) {
    return { ok: false, reason: null };
  }

  st.msgs = st.msgs.filter((ts) => now - ts < FLOOD_WINDOW_MS);
  st.msgs.push(now);
  if (st.msgs.length > FLOOD_MAX_MSGS) {
    st.cooldownUntil = now + FLOOD_COOLDOWN_MS;
    st.msgs = [];
    return { ok: false, reason: `⏸ Слишком быстро пишешь. Передохни минуту и продолжим 🤍` };
  }
  st.lastTs = now;

  let text = rawText || "";
  let truncated = false;
  if (text.length > MAX_INPUT_LEN) {
    text = text.slice(0, MAX_INPUT_LEN);
    truncated = true;
  }

  return { ok: true, text, truncated };
}

// --- Public: per-user квоты ---
// kind: "text" | "voice" | "search"
async function checkAndConsumeQuota(participant, kind) {
  await ensureMonthStateLoaded();

  if (!participant) return { ok: true, role: "Founder", remaining: {} };

  const role = getRole(participant);
  const quota = QUOTAS[role] || QUOTAS["Гость"];

  const reset = getResetDate(participant);
  const today = todayKey();
  const currentMonth = monthKey();
  let msgs   = getCounter(participant, "msgs_today");
  let voice  = getCounter(participant, "voice_today");
  let tokens = getCounter(participant, "tokens_today");

  if (reset !== today) {
    msgs = 0; voice = 0; tokens = 0;
  }

  // --- Месячный лимит поиска для Гостей ---
  if (kind === "search" && isFinite(quota.searchesMonth)) {
    const savedMonthKey = getSearchesMonthKey(participant);
    const searches = savedMonthKey === currentMonth ? getSearchesMonth(participant) : 0;

    if (searches >= quota.searchesMonth) {
      return {
        ok: false,
        role,
        reason: `🔍 Лимит поиска на этот месяц исчерпан (${quota.searchesMonth} поисков).\n\nЧтобы продолжить — вступи в NextGen Club. Напиши @Viktor_Drake или нажми /start.`,
      };
    }

    // Инкремент searches
    const newSearches = searches + 1;
    notion.pages.update({
      page_id: participant.id,
      properties: {
        searches_month: { number: newSearches },
        searches_month_key: { rich_text: [{ text: { content: currentMonth } }] },
      },
    }).catch((e) => console.warn(`[limits] update searches failed: ${e.message}`));

    // Предупреждение на 80% поисков
    let warning = null;
    if (newSearches / quota.searchesMonth >= 0.8) {
      const left = quota.searchesMonth - newSearches;
      warning = `⚠️ Осталось ${left} из ${quota.searchesMonth} поисков в этом месяце.`;
    }

    return { ok: true, role, warning, remaining: { searches: quota.searchesMonth - newSearches } };
  }

  // --- Дневные квоты ---
  if (kind === "voice" && voice >= quota.voice) {
    return {
      ok: false,
      role,
      reason: quota.voice === 0
        ? "Голосовые пока доступны только участникам клуба 🤍"
        : `На сегодня лимит голосовых исчерпан (${quota.voice}/день). Завтра обнулится 🤍`,
    };
  }
  if (msgs >= quota.msgs) {
    return {
      ok: false,
      role,
      reason: `Слушай, мы сегодня уже наговорились (${quota.msgs} сообщений) — давай продолжим завтра? 🤍 Если что-то срочное — пиши @Viktor_Drake.`,
    };
  }
  if (tokens >= quota.tokens) {
    return {
      ok: false,
      role,
      reason: `На сегодня закончился дневной бюджет общения. Завтра обнулится 🤍`,
    };
  }

  // --- Месячный кап ($) ---
  if (monthState.monthKey !== monthKey()) {
    monthState.spentUsd = 0;
    monthState.monthKey = monthKey();
    monthState.loaded = false;
    _loadingPromise = null;
  }
  if (monthState.spentUsd >= MONTH_CAP_USD) {
    return {
      ok: false,
      role,
      reason: "Нова отдыхает до конца месяца 🤍 Если что-то важное — напиши @Viktor_Drake напрямую.",
    };
  }

  const newMsgs  = msgs + 1;
  const newVoice = voice + (kind === "voice" ? 1 : 0);

  notion.pages.update({
    page_id: participant.id,
    properties: {
      msgs_today:   { number: newMsgs },
      voice_today:  { number: newVoice },
      tokens_today: { number: tokens },
      quota_reset:  { date: { start: today } },
    },
  }).catch((e) => console.warn(`[limits] update counters failed: ${e.message}`));

  // Предупреждение на 80% сообщений
  let warning = null;
  if (isFinite(quota.msgs) && newMsgs / quota.msgs >= 0.8) {
    const left = quota.msgs - newMsgs;
    warning = `⚠️ Осталось ${left} из ${quota.msgs} сообщений на сегодня. Завтра обнулится.`;
  }

  return {
    ok: true,
    role,
    warning,
    remaining: {
      msgs:   quota.msgs - newMsgs,
      voice:  quota.voice - newVoice,
      tokens: quota.tokens - tokens,
    },
  };
}

// --- Public: записать токены после AI-вызова ---
async function recordTokens(participant, inputTokens, outputTokens, model = "haiku") {
  if (!participant) return;

  await ensureMonthStateLoaded();

  const total   = (inputTokens || 0) + (outputTokens || 0);
  const current = getCounter(participant, "tokens_today");
  const reset   = getResetDate(participant);
  const today   = todayKey();
  const newTotal = (reset === today ? current : 0) + total;

  const isHaiku = model.includes("haiku");
  const inCost  = (inputTokens  || 0) * (isHaiku ? 1  : 3)  / 1_000_000;
  const outCost = (outputTokens || 0) * (isHaiku ? 5  : 15) / 1_000_000;
  monthState.spentUsd += inCost + outCost;

  notion.pages.update({
    page_id: participant.id,
    properties: {
      tokens_today: { number: newTotal },
      quota_reset:  { date: { start: today } },
    },
  }).catch((e) => console.warn(`[limits] recordTokens failed: ${e.message}`));

  // Сохраняем месячный расход в Notion (cold start fix)
  saveMonthSpend(monthState.spentUsd, monthState.monthKey).catch(() => {});
}

// --- Public: текущая модель с учётом downgrade ---
async function getModelMode() {
  await ensureMonthStateLoaded();
  const spent = monthState.spentUsd;
  if (spent >= MONTH_NO_TTS_USD) return { model: "anthropic/claude-haiku-4-5", allowTTS: false,  level: "no-tts"     };
  if (spent >= MONTH_WARN_USD)   return { model: "anthropic/claude-haiku-4-5", allowTTS: true,   level: "haiku-only" };
  return                                 { model: "anthropic/claude-haiku-4-5", allowTTS: true,   level: "normal"     };
}

// --- Public: ensure роль установлена ---
async function ensureRole(participant, defaultRole = "Гость") {
  if (!participant) return;
  const role = getRole(participant);
  if (role && role !== "Гость") return;
  const current = participant.properties?.["Роль"]?.select;
  if (current?.name) return;
  await notion.pages.update({
    page_id: participant.id,
    properties: { "Роль": { select: { name: defaultRole } } },
  }).catch((e) => console.warn(`[limits] ensureRole failed: ${e.message}`));
}

// --- Public: debug stats ---
async function getStats() {
  await ensureMonthStateLoaded();
  return {
    monthSpentUsd: monthState.spentUsd.toFixed(4),
    monthCapUsd:   MONTH_CAP_USD,
    floodTracked:  floodState.size,
    monthKey:      monthState.monthKey,
    loadedFromNotion: monthState.loaded,
  };
}

module.exports = {
  checkPerMessage,
  checkAndConsumeQuota,
  recordTokens,
  getModelMode,
  ensureRole,
  getStats,
  QUOTAS,
};
