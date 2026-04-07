// Лимиты Новы — защита от спама и сжигания токенов.
//
// Три уровня защиты:
//   1. Per-message guards (длина, anti-flood) — мгновенная, in-memory
//   2. Per-user квоты (сообщения / голос / токены в сутки) — Notion
//   3. Глобальный месячный кап ($) — in-memory + env, перекрывается на новом cold start
//
// Роли (поле "Роль" в Notion):
//   - Гость       — 10 текста, 0 голоса, 20K токенов
//   - Участник    — 50 текста, 15 голоса, 80K токенов
//   - VIP         — 150 текста, 45 голоса, 300K токенов
//   - Founder     — без лимитов

const { notion } = require("./notion");

const MAX_INPUT_LEN = 2000;
const FLOOD_WINDOW_MS = 30_000;     // окно для anti-flood
const FLOOD_MAX_MSGS = 5;           // > этого в окне → cooldown
const FLOOD_COOLDOWN_MS = 60_000;   // длительность cooldown
const MIN_INTERVAL_MS = 1500;       // минимум между сообщениями

const QUOTAS = {
  "Гость":    { msgs: 200, voice: 60,  tokens: 400_000 },
  "Участник": { msgs: 200, voice: 60,  tokens: 400_000 },
  "VIP":      { msgs: 500, voice: 150, tokens: 1_000_000 },
  "Founder":  { msgs: Infinity, voice: Infinity, tokens: Infinity },
};

const MONTH_CAP_USD = parseFloat(process.env.NOVA_MONTH_CAP_USD || "40");
const MONTH_WARN_USD = MONTH_CAP_USD * 0.7;
const MONTH_NO_TTS_USD = MONTH_CAP_USD * 0.85;

// --- In-memory state (живёт между тёплыми инвокациями) ---
const floodState = new Map();   // chatId → { lastTs, msgs: [ts...], cooldownUntil }
const monthState = { spentUsd: 0, monthKey: monthKey() };

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getRole(participant) {
  const p = participant?.properties?.["Роль"];
  return p?.select?.name || "Гость";
}

function getCounter(participant, fieldName) {
  const p = participant?.properties?.[fieldName];
  return p?.number || 0;
}

function getResetDate(participant) {
  const p = participant?.properties?.quota_reset;
  return p?.date?.start || null;
}

// --- Public: per-message guards (синхронно, без Notion) ---
// Возвращает { ok, reason?, text? } — text может быть обрезан
function checkPerMessage(chatId, rawText) {
  const now = Date.now();
  let st = floodState.get(chatId);
  if (!st) {
    st = { lastTs: 0, msgs: [], cooldownUntil: 0 };
    floodState.set(chatId, st);
  }

  // 1. Cooldown активен?
  if (st.cooldownUntil > now) {
    const sec = Math.ceil((st.cooldownUntil - now) / 1000);
    return { ok: false, reason: `⏸ Слишком много сообщений подряд. Подожди ${sec} сек и продолжим 🤍` };
  }

  // 2. Минимальный интервал
  if (st.lastTs && now - st.lastTs < MIN_INTERVAL_MS) {
    return { ok: false, reason: null }; // молча игнорим, не отвечаем — дребезг
  }

  // 3. Anti-flood окно
  st.msgs = st.msgs.filter((ts) => now - ts < FLOOD_WINDOW_MS);
  st.msgs.push(now);
  if (st.msgs.length > FLOOD_MAX_MSGS) {
    st.cooldownUntil = now + FLOOD_COOLDOWN_MS;
    st.msgs = [];
    return { ok: false, reason: `⏸ Слишком быстро пишешь. Передохни минуту и продолжим 🤍` };
  }
  st.lastTs = now;

  // 4. Длина
  let text = rawText || "";
  let truncated = false;
  if (text.length > MAX_INPUT_LEN) {
    text = text.slice(0, MAX_INPUT_LEN);
    truncated = true;
  }

  return { ok: true, text, truncated };
}

// --- Public: per-user квоты (через Notion) ---
// Вызывается ПЕРЕД дорогой AI-операцией
// kind: "text" | "voice"
// Возвращает { ok, reason?, role, remaining }
async function checkAndConsumeQuota(participant, kind) {
  if (!participant) return { ok: true, role: "Founder", remaining: {} };

  const role = getRole(participant);
  const quota = QUOTAS[role] || QUOTAS["Гость"];

  // Сброс счётчиков если новый день
  const reset = getResetDate(participant);
  const today = todayKey();
  let msgs = getCounter(participant, "msgs_today");
  let voice = getCounter(participant, "voice_today");
  let tokens = getCounter(participant, "tokens_today");

  if (reset !== today) {
    msgs = 0;
    voice = 0;
    tokens = 0;
  }

  // Проверка квот
  if (kind === "voice" && voice >= quota.voice) {
    return {
      ok: false,
      role,
      reason: quota.voice === 0
        ? "Голосовые пока доступны только участникам клуба. Заполни анкету (📝), чтобы открыть полный доступ 🤍"
        : `На сегодня лимит голосовых исчерпан (${quota.voice}/день). Завтра обнулится — продолжим 🤍`,
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

  // Месячный кап
  if (monthState.monthKey !== monthKey()) {
    monthState.spentUsd = 0;
    monthState.monthKey = monthKey();
  }
  if (monthState.spentUsd >= MONTH_CAP_USD) {
    return {
      ok: false,
      role,
      reason: "Нова отдыхает до конца месяца 🤍 Если что-то важное — напиши @Viktor_Drake напрямую.",
    };
  }

  // Инкремент счётчиков (без блокировки — fire and forget безопасен, но логируем)
  const newMsgs = msgs + 1;
  const newVoice = voice + (kind === "voice" ? 1 : 0);

  notion.pages.update({
    page_id: participant.id,
    properties: {
      msgs_today: { number: newMsgs },
      voice_today: { number: newVoice },
      tokens_today: { number: tokens }, // токены добавит recordTokens()
      quota_reset: { date: { start: today } },
    },
  }).catch((e) => console.warn(`[limits] update counters failed: ${e.message}`));

  return {
    ok: true,
    role,
    remaining: {
      msgs: quota.msgs - newMsgs,
      voice: quota.voice - newVoice,
      tokens: quota.tokens - tokens,
    },
  };
}

// --- Public: записать использование токенов после AI-вызова ---
async function recordTokens(participant, inputTokens, outputTokens, model = "haiku") {
  if (!participant) return;

  const total = (inputTokens || 0) + (outputTokens || 0);
  const current = getCounter(participant, "tokens_today");
  const reset = getResetDate(participant);
  const today = todayKey();
  const newTotal = (reset === today ? current : 0) + total;

  // Грубая оценка $ (Haiku 4.5: $1/$5 per 1M; Sonnet 4.5: $3/$15 per 1M)
  const isHaiku = model.includes("haiku");
  const inCost = (inputTokens || 0) * (isHaiku ? 1 : 3) / 1_000_000;
  const outCost = (outputTokens || 0) * (isHaiku ? 5 : 15) / 1_000_000;
  monthState.spentUsd += inCost + outCost;

  notion.pages.update({
    page_id: participant.id,
    properties: {
      tokens_today: { number: newTotal },
      quota_reset: { date: { start: today } },
    },
  }).catch((e) => console.warn(`[limits] recordTokens failed: ${e.message}`));
}

// --- Public: текущая модель с учётом downgrade ---
// Возвращает имя модели OpenRouter и флаг allowTTS
function getModelMode() {
  const spent = monthState.spentUsd;
  if (spent >= MONTH_NO_TTS_USD) {
    return { model: "anthropic/claude-haiku-4-5", allowTTS: false, level: "no-tts" };
  }
  if (spent >= MONTH_WARN_USD) {
    return { model: "anthropic/claude-haiku-4-5", allowTTS: true, level: "haiku-only" };
  }
  return { model: "anthropic/claude-haiku-4-5", allowTTS: true, level: "normal" };
}

// --- Public: ensure роль установлена (для новых участников) ---
async function ensureRole(participant, defaultRole = "Гость") {
  if (!participant) return;
  const role = getRole(participant);
  if (role && role !== "Гость") return; // уже что-то выставлено
  const current = participant.properties?.["Роль"]?.select;
  if (current?.name) return;
  await notion.pages.update({
    page_id: participant.id,
    properties: { "Роль": { select: { name: defaultRole } } },
  }).catch((e) => console.warn(`[limits] ensureRole failed: ${e.message}`));
}

// --- Public: debug stats ---
function getStats() {
  return {
    monthSpentUsd: monthState.spentUsd.toFixed(4),
    monthCapUsd: MONTH_CAP_USD,
    floodTracked: floodState.size,
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
