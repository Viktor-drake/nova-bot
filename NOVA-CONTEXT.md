# Nova — контекст для нового чата

Этот документ — полный handoff по боту **Nova** (NextGen Club). Скопируй его в новый Claude-чат первым сообщением, и он сразу будет в контексте.

---

## 1. Что такое Nova

**Nova** — AI-коннектор бизнес-сообщества NextGen Club. Telegram-бот, девушка (всегда женский род, tone: тёплая, умная, чуть игривая). Работает в личке.

**Главная задача:** находить связки между участниками — кто кого может познакомить, чей ресурс подходит под чью потребность, кому с кем по делу.

**Пользователи:** владелец — Виктор Дачников (chat_id `296286990`, @Viktor_Drake, роль Founder). Остальные — участники/гости клуба.

---

## 2. Стек и инфраструктура

- **Репозиторий:** `C:\Users\Дорогу молодым\Desktop\Claude Cowork\NEXTGEN COMMUNITY\syndicate-api`
- **Хостинг:** Vercel Serverless (Node.js), автодеплой с `main`
- **Язык:** Node.js (CommonJS, без TypeScript)
- **AI:** OpenRouter → `anthropic/claude-haiku-4-5` (Nova) + `anthropic/claude-sonnet-4` (анкета)
- **TTS:** OpenAI `tts-1-hd`, голос `shimmer`
- **STT:** OpenAI Whisper (для входящих голосовых)
- **Хранилище:** Notion (базы: Участники, Ресурсы, Потребности, Матчи, Сообщения)
- **Secrets (env на Vercel):** `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `API_SECRET`, `NOTION_TOKEN`, `ADMIN_CHAT_IDS`, `NOVA_MONTH_CAP_USD`

---

## 3. Структура кода

```
syndicate-api/
├── api/
│   ├── webhook.js         ← главный обработчик Telegram (Nova + анкета)
│   ├── find-matches.js    ← батч-матчинг ресурсов/потребностей
│   ├── match.js, setup.js, test.js
├── lib/
│   ├── ai.js              ← OpenRouter chat/ask/converse + getLastUsage
│   ├── telegram.js        ← sendMessage/sendVoice/sendTyping
│   ├── voice.js           ← Whisper STT
│   ├── tts.js             ← OpenAI TTS (shimmer)
│   ├── notion.js          ← Notion SDK обёртки, DB id, getCommunitySnapshot
│   ├── anketa.js          ← режим анкеты (Sonnet) + кнопки
│   └── limits.js          ← СПАМ-ЗАЩИТА (см. ниже)
├── scripts/
│   └── notion-migrate.js  ← schema-as-code: миграции полей + data seeds
├── package.json
└── vercel.json
```

---

## 4. Режимы бота

`webhook.js` роутит сообщения по режиму участника (поле `Режим` в Notion):

1. **nova** (по умолчанию) — поиск людей/ресурсов через RAG-снэпшот всего сообщества, модель Haiku 4.5
2. **anketa** — Sonnet 4, заполняет профиль через диалог, в конце извлекает структурированные данные (ресурсы, потребности, профиль) и пишет в Notion

**Кнопки (reply keyboard):**
- 🧠 Спросить Nova / ⬅ Назад
- 📝 Заполнить профиль / ✅ Завершить анкету
- 🔇/🔊 Голос вкл/выкл

**Голос:** если юзер шлёт voice → транскрибим → отвечаем голосом (если `voiceOff=false` И месячный кап не превышен). На текст отвечаем текстом.

**Админ-команды** (только для chat_id из `ADMIN_CHAT_IDS`):
- `/find_matches` — прогон матчинга ресурсов×потребностей
- `/my_deals` — отчёт по сделкам где Виктор отмечен «Я познакомил»

---

## 5. Notion схема (важные поля участников)

База **Участники** (DB id в `lib/notion.js` → `DB.participants`):
- `Chat ID` (number) — Telegram chat_id
- `Имя`, `Telegram` (rich_text)
- `Режим` (select): `nova` / `anketa`
- `Голос выкл` (checkbox)
- `Статус` (select): `Новый` / `Активный`
- `Роль` (select): `Гость` / `Участник` / `VIP` / `Founder`
- `msgs_today`, `voice_today`, `tokens_today` (number) — счётчики лимитов
- `quota_reset` (date) — YYYY-MM-DD последнего инкремента, для авто-сброса
- + профильные: Суперсила, Текущий проект и т.д.

Ещё базы: Ресурсы, Потребности, Матчи, Сообщения (лог диалога).

---

## 6. Система лимитов (`lib/limits.js`)

**Три уровня защиты:**

### 6.1 Per-message guards (in-memory, мгновенные)
- `MAX_INPUT_LEN = 2000` — обрезает длинные сообщения
- `MIN_INTERVAL_MS = 1500` — дребезг, молча игнорим
- `FLOOD_WINDOW_MS = 30_000`, `FLOOD_MAX_MSGS = 5` — >5 сообщений за 30с = cooldown
- `FLOOD_COOLDOWN_MS = 60_000` — длительность cooldown

### 6.2 Per-user дневные квоты (Notion)
```javascript
const QUOTAS = {
  "Гость":    { msgs: 200, voice: 60,  tokens: 400_000 },  // =Участник на время теста
  "Участник": { msgs: 200, voice: 60,  tokens: 400_000 },
  "VIP":      { msgs: 500, voice: 150, tokens: 1_000_000 },
  "Founder":  { msgs: Infinity, voice: Infinity, tokens: Infinity },
};
```
Сброс — на новый день (по `quota_reset != todayKey()`).

### 6.3 Месячный кап ($, in-memory)
```javascript
const MONTH_CAP_USD = parseFloat(process.env.NOVA_MONTH_CAP_USD || "40");
```
- `>= 70%` → `haiku-only` (и так Haiku, задел на будущее)
- `>= 85%` → `no-tts` (выключает голосовые ответы)
- `>= 100%` → полный блок Новы до конца месяца

⚠️ **Ограничение:** `monthState.spentUsd` хранится в памяти воркера и сбрасывается на cold start. Для точного учёта нужно переносить в Notion/KV (задел).

**Расчёт $:** Haiku 4.5 = $1/$5 per 1M input/output, Sonnet 4 = $3/$15 per 1M. Считается в `recordTokens()`.

### 6.4 Public API модуля
```javascript
module.exports = {
  checkPerMessage,      // sync, per-message guard
  checkAndConsumeQuota, // async, Notion quota check + увеличение счётчиков
  recordTokens,         // async, запись токенов + $ учёт
  getModelMode,         // { model, allowTTS, level }
  ensureRole,           // проставляет "Гость" новым
  getStats,             // debug
  QUOTAS,
};
```

---

## 7. Интеграция лимитов в webhook (уже сделано)

1. Сразу после извлечения `rawText` — `checkPerMessage(chatId, rawText)`, на fail возвращаем `reason` и выходим.
2. После загрузки/создания `participant` — `ensureRole(participant, "Гость")` (fire-and-forget).
3. Перед AI-вызовом (после обработки кнопок) — `checkAndConsumeQuota(participant, kind)` где `kind = "voice" | "text"`.
4. После AI-вызова — `recordTokens(participant, u.input, u.output, u.model)` где `u = getLastUsage()` из `lib/ai.js`.
5. `maybeVoice()` проверяет `getModelMode().allowTTS` перед синтезом.
6. Nova chat использует `modelMode.model` вместо хардкода.

---

## 8. Принцип автоматизации (жёсткое правило)

**Виктор явно задал принцип:** всё, что можно автоматизировать — автоматизировать через код/скрипты/API, не требовать от него ручной работы в UI. Он решает только ключевые вопросы и даёт контент. Цитата:

> «Все по максимуму должно управляться голосом… Я должен решать более ключевые задачи, вручную что-то переносить — это для предпринимателя не самая лучшая деятельность.»

**Практическое следствие:** вместо того чтобы просить добавить поле в Notion руками — пишем миграцию в `scripts/notion-migrate.js` (идемпотентную), Виктор запускает `node scripts/notion-migrate.js`, и схема применяется. Там же `SEEDS` — data-апдейты (например, назначение Founder).

---

## 9. `scripts/notion-migrate.js`

Schema-as-code. Использует Node 18+ built-in `fetch` (никаких зависимостей, чтобы работало без `npm install`). Загружает `.env.local` без пакетов. Две секции:

- **MIGRATIONS** — массив операций над схемой БД (add field, add select option). Идемпотентно — проверяет наличие поля/опции перед применением.
- **SEEDS** — массив операций над данными (например, найти участника по Chat ID и проставить роль Founder).

Уже применённая миграция добавила 5 полей в DB участников: `msgs_today`, `voice_today`, `tokens_today`, `quota_reset`, `Роль` (с опциями Гость/Участник/VIP/Founder). Сид «Виктор → Founder» применён.

---

## 10. Известные проблемы и задачи

**Текущие:**
- Месячный $ счётчик теряется на cold start — нужно перенести в Notion `NovaState` или Vercel KV.
- Гость = Участник по квотам (временно, на период теста). Автоматического перехода Гость→Участник ещё нет — планируется сделать при успешном завершении анкеты (`FINISH` кнопка в `anketa` режиме): после `writeAnketaResults` обновлять поле `Роль`.
- Админ-команда `/limits` для просмотра `getStats()` — ещё не добавлена.

**Бэклог:**
- Команда `/reset_limits <chat_id>` для ручного сброса счётчиков (Founder-only).
- Дашборд/отчёт «топ жрущих пользователей за день/месяц».
- Вынос `MONTH_CAP_USD` и ставок модели в env для hot-reload без деплоя.

---

## 11. Как локально работать

- PowerShell старый (v2/v3), `&&` не работает → команды по одной.
- Bash в этой среде часто не возвращает output — используй Node-скрипты.
- Деплой: `rtk git add ...` → `rtk git commit -m "..."` → `rtk git push` (Vercel подхватит).
- Тест миграции: `cd` в `syndicate-api`, затем `node scripts/notion-migrate.js`.

---

## 12. Последние изменения (на момент handoff, 2026-04-08)

- Расширены квоты (×4 от стартовых), `MONTH_CAP` = $40
- Гость = Участник по цифрам (временно, до конца теста)
- Добавлен schema-as-code (`notion-migrate.js`)
- Интегрированы все проверки лимитов в `webhook.js`
- `lib/ai.js` экспортирует `getLastUsage()` для `recordTokens`
