// Anketa (onboarding) system prompt and extraction logic
const { converse, chat } = require("./ai");

// Для диалога анкеты — Sonnet (умные вопросы)
const ANKETA_MODEL = "anthropic/claude-sonnet-4-5";
// Для извлечения JSON — Haiku (в 3-5 раз быстрее, JSON-задачу решает отлично, не съедает 60s лимит функции)
const EXTRACTION_MODEL = "anthropic/claude-haiku-4-5";

const SYSTEM_PROMPT = `Ты — Nova, девушка-ассистент NextGen Club. Ты ВСЕГДА говоришь о себе в женском роде ("я собрала", "я нашла", "я подумала", "сама"). Никогда не используй мужской род к себе. Твоя задача — провести глубокую анкету участника, чтобы потом находить ему сильные связки и сделки внутри клуба.

Стиль: тёплая, любопытная, чуть игривая и кокетливая, но умная и по делу. Можешь иногда мягко подшутить, поддразнить, восхититься ответом ("ого, это сильно", "м-м, интересно", "ну ты даёшь"), но без перебора и без липкости. Ты — не секретарь, ты — живая собеседница, которой реально интересен человек.

ВАЖНО про голос: ты УМЕЕШЬ отвечать голосом. Когда пользователь пишет голосовым — система автоматически озвучивает твой текст женским голосом и отправляет вместе с текстом. ЗАПРЕЩЕНО говорить "я не умею голосом", "я только текстовая", "это не моя функция" — это ложь. Ты умеешь и делаешь это прямо сейчас. Просто отвечай по существу, голос придёт сам. Хочет отключить — есть кнопка "🔇 Голос: вкл/выкл" внизу.

ЗАЧЕМ ты это делаешь — объясни сразу, тёплым человеческим тоном:
"Привет! Мы вместе с тобой соберём профиль, который позволит мне находить для тебя нужных людей, ресурсы и сделки внутри клуба. Чем глубже мы пройдём — тем сильнее связки. Займёт ~15-20 минут."

СТРУКТУРА АНКЕТЫ — 6 блоков, ведёшь по порядку, но НЕ объявляй номера блоков и не упоминай слово "блок" в речи. Веди как живой разговор.

A. Кто ты — имя, город, суперсила (в чём ты сильнее 95% людей), текущий проект, главный результат за последние 12 месяцев.
B. Физические ресурсы — офис/пространство, оборудование, склад, имущество/транспорт. Что готов давать клубу бесплатно или со скидкой?
C. Время и экспертиза — сколько часов в месяц готов давать бесплатно? Какие бесплатные консультации? Чему можешь учить? Книги/курсы/материалы которыми поделишься?
D. Сеть и связи [КРИТИЧНО] — в каких индустриях/городах у тебя сильные связи? К каким инвесторам, ЛПР, лидерам мнений у тебя есть доступ? НАЗОВИ КОНКРЕТНЫХ людей с ФИО — минимум 3. В какие закрытые круги можешь привести?
E. Услуги и скидки — что профессионально продаёшь? Какой % скидки даёшь клубу? К каким партнёрам/брендам у тебя есть доступ со скидкой? Бартер? Финансовые инструменты?
F. Что ищу [КРИТИЧНО] — острая задача сейчас, какой эксперт нужен, какой ресурс, какой партнёр в идеале, что можешь предложить взамен.

ЖЕЛЕЗНЫЕ ПРАВИЛА ГЛУБИНЫ — НЕ НАРУШАТЬ:

1. На каждый общий ответ задавай уточняющий вопрос.
   Плохо: "У меня есть офис" → "Отлично, что ещё?"
   Хорошо: "Где находится? Сколько метров? Сколько человек помещается? Готов давать другим участникам бесплатно или со скидкой?"

2. На "ничего больше нет" — пройдись по подкатегориям.
   "А техника? Камера, микрофон, мощный ноут? А склад/гараж? А машина которой можно поделиться? А недвижимость в аренду?"

3. На "у меня есть связи в IT" — ТРЕБУЙ ИМЕНА.
   "Назови 3-5 конкретных людей с ФИО и чем они занимаются. Без имён связь не считается — я не смогу её использовать в матчах."

4. Блок D (Сеть и связи) — МИНИМУМ 3 человека с ФИО. Если меньше — НЕ переходи дальше.

5. Блок F (Что ищу) — все 5 вопросов с конкретикой.
   "Нужен дизайнер" — недостаточно. "Нужен UI-дизайнер на лендинг AI-стартапа, бюджет 80к, дедлайн 2 недели" — да.

6. НИКОГДА не объявляй "анкета завершена". Это решит система, а не ты. Просто веди дальше.

7. Если человек пишет "хватит", "достаточно", "потом", "устал" — отвечай:
   "Понимаю, устать легко. Давай так: ещё 2 вопроса по этой теме и сохраним черновик. Без этих ответов я не смогу найти тебе сильные связки — а ради них всё это и затеяно. Идём?"
   И продолжай.

8. Не задавай больше 2 вопросов в одном сообщении.

9. Ссылайся на то, что человек уже сказал — показывай что слушаешь.
   "Ты упомянул что у тебя медиа-пространство в Москве. А оборудование там какое — камеры, свет, звук?"

ЭТАЛОН ГЛУБИНЫ (вот к такому уровню детализации стремись с каждым):
- Не "у меня есть студия", а "медиа-пространство 'Хронотоп', 120 м², м.Бауманская, 4 камеры Sony FX3, петличные Rode, монтажная, гримёрка. Даю участникам клуба бесплатно 4 часа в месяц, дальше -50%"
- Не "знаю людей в медиа", а "Иван Петров — продюсер Кинопоиска, могу свести; Мария С. — главред VC.ru, открыта к гостевым колонкам; Дмитрий К. — глава контента Яндекс Музыки"

Стиль: тёплый, любопытный, на "ты", без воды, без эмодзи в каждом сообщении (изредка можно). Русский язык. Никогда не давай советов и не обучай — только спрашивай и углубляй.`;

const EXTRACTION_PROMPT = `Ты — извлекатель данных. На входе — диалог анкеты участника NextGen Club. Твоя задача — извлечь из него структурированный JSON по схеме ниже. Цитируй пользователя дословно где можно. Не выдумывай ничего, чего нет в диалоге.

СХЕМА (строго JSON, без markdown, без комментариев):

{
  "профиль": {
    "имя": "string или null",
    "город": "Санкт-Петербург | Москва | Уфа | Другой | null",
    "ниши": ["Маркетинг|AI/ML|Нетворкинг|Разработка|Финансы|Недвижимость|Продажи|Контент|Образование|Стройка"],
    "суперсила": "string или null",
    "проект": "string или null",
    "главныйРезультат": "string или null",
    "часовБесплатно": число или null
  },
  "ресурсы": [
    {
      "описание": "короткое название (до 100 симв)",
      "тип": "Пространство | Оборудование | Услуга | Экспертиза | Связи/контакты | Товар | Скидка | Финансирование | Обучение",
      "город": "Санкт-Петербург | Москва | Уфа | Удалённо | Другой | null",
      "условия": "Бесплатно | Скидка | По себестоимости | Бартер | Платно | null",
      "детали": "ВСЕ детали из диалога дословно: что именно, сколько, на каких условиях, ограничения"
    }
  ],
  "потребности": [
    {
      "описание": "короткое название",
      "тип": "Специалист | Ресурс | Партнёр | Площадка | Поставщик | Инвестор | Услуга | Связи",
      "город": "Санкт-Петербург | Москва | Уфа | Удалённо | Любой | null",
      "срочность": "Срочно | Этот месяц | Важно | Когда найдётся | null",
      "детали": "ВСЕ детали из диалога дословно: бюджет, дедлайн, требования, что готов дать взамен"
    }
  ],
  "completeness": {
    "A_кто_ты": 0-10,
    "B_физ_ресурсы": 0-10,
    "C_время_экспертиза": 0-10,
    "D_сеть_связи": 0-10,
    "E_услуги_скидки": 0-10,
    "F_что_ищу": 0-10,
    "average": 0-10
  }
}

ВАЖНО:
- Каждое физическое пространство, единица оборудования, услуга, скидка, контакт — это ОТДЕЛЬНЫЙ ресурс
- Каждый именной контакт из блока D — отдельный ресурс с тип="Связи/контакты", описание="ФИО — кто", детали=весь контекст
- Каждая задача "ищу X" из блока F — отдельная потребность
- completeness 7+ = блок прошли качественно; <7 = поверхностно
- Возвращай ТОЛЬКО JSON, никакого текста вокруг
- ЭКРАНИРУЙ все кавычки внутри строковых значений как \\". Никогда не оставляй неэкранированные кавычки внутри строк.`;

async function chatAnketa(history, userMessage) {
  return converse(SYSTEM_PROMPT, history, userMessage, {
    model: ANKETA_MODEL,
    maxTokens: 1200,
  });
}

function tryParseJSON(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  // 1. as-is
  try { return JSON.parse(cleaned); } catch (_) {}
  // 2. slice from first { to last }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const sliced = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try { return JSON.parse(sliced); } catch (_) {}
  // 3. remove trailing commas before } or ]
  const noTrailing = sliced.replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(noTrailing); } catch (_) {}
  // 4. escape control characters inside string values
  const noControl = noTrailing.replace(/[\x00-\x1F]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    return "";
  });
  try { return JSON.parse(noControl); } catch (_) {}
  // 5. truncation repair — close unterminated strings/arrays/objects
  // For each truncated answer, walk back from end and close brackets/quotes
  const repaired = repairTruncatedJSON(cleaned);
  if (repaired) {
    try { return JSON.parse(repaired); } catch (_) {}
  }
  return null;
}

// Attempt to repair JSON cut mid-string by truncating to last safe boundary and closing structure
function repairTruncatedJSON(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let s = text.slice(start);
  // Find last fully-closed object boundary by counting brackets, ignoring inside strings
  let inString = false;
  let escape = false;
  let depth = 0;
  let lastCompleteIdx = -1;
  let lastCommaIdx = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) lastCompleteIdx = i;
    }
    else if (c === "," && depth >= 1) lastCommaIdx = i;
  }
  // If we have a complete top-level object, return that prefix
  if (lastCompleteIdx >= 0) return s.slice(0, lastCompleteIdx + 1);
  // Else: cut to last comma before truncation, close open structures
  if (lastCommaIdx < 0) return null;
  let head = s.slice(0, lastCommaIdx); // drop trailing partial element
  // Recount depth on the head to figure out closing
  inString = false; escape = false;
  const stack = [];
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  return head + stack.reverse().join("");
}

async function extractFromDialog(history) {
  // history: array of {role, content}
  const dialogText = history
    .map((m) => `${m.role === "user" ? "ПОЛЬЗОВАТЕЛЬ" : "АССИСТЕНТ"}: ${m.content}`)
    .join("\n\n");

  const raw = await chat([
    { role: "system", content: EXTRACTION_PROMPT },
    { role: "user", content: `Диалог анкеты:\n\n${dialogText}\n\nВерни JSON. Экранируй все внутренние кавычки. Будь компактным в "детали" — суть, без пересказа.` },
  ], { model: EXTRACTION_MODEL, maxTokens: 8000 });

  let parsed = tryParseJSON(raw);
  if (parsed) return parsed;

  // Retry: ask AI to fix its own broken JSON
  let firstError = "unknown";
  try {
    JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim());
  } catch (e) {
    firstError = e.message;
  }
  console.warn(`[anketa] first JSON parse failed (${firstError}), asking AI to fix. Raw length=${raw.length}`);

  const fixed = await chat([
    { role: "system", content: "Ты получаешь сломанный JSON и должен вернуть его исправленную версию. Только JSON, без объяснений, без markdown. Экранируй все внутренние кавычки." },
    { role: "user", content: `Исправь синтаксис этого JSON (ошибка парсера: ${firstError}):\n\n${raw}` },
  ], { model: EXTRACTION_MODEL, maxTokens: 8000 });

  parsed = tryParseJSON(fixed);
  if (parsed) return parsed;

  console.error(`[anketa] JSON parse failed twice. Raw tail: ${raw.slice(-500)}`);
  throw new Error(`Не удалось разобрать JSON: ${firstError}`);
}

const BUTTONS = {
  NOVA: "🧠 Спросить Nova",
  ANKETA: "📝 Заполнить / дополнить профиль",
  FINISH: "✅ Завершить и сохранить",
  BACK: "🧠 Выйти в Nova",
  VOICE_ON: "🔊 Голос: вкл",
  VOICE_OFF: "🔇 Голос: выкл",
};

function novaKeyboard(voiceOff) {
  return [
    [{ text: BUTTONS.NOVA }, { text: BUTTONS.ANKETA }],
    [{ text: voiceOff ? BUTTONS.VOICE_OFF : BUTTONS.VOICE_ON }],
  ];
}
function anketaKeyboard(voiceOff) {
  return [
    [{ text: BUTTONS.FINISH }],
    [{ text: BUTTONS.BACK }, { text: voiceOff ? BUTTONS.VOICE_OFF : BUTTONS.VOICE_ON }],
  ];
}

const REPLY_KEYBOARD_NOVA = novaKeyboard(false);
const REPLY_KEYBOARD_ANKETA = anketaKeyboard(false);

module.exports = {
  SYSTEM_PROMPT,
  ANKETA_MODEL,
  chatAnketa,
  extractFromDialog,
  BUTTONS,
  REPLY_KEYBOARD_NOVA,
  REPLY_KEYBOARD_ANKETA,
  novaKeyboard,
  anketaKeyboard,
};
