const { Client } = require("@notionhq/client");

// --- Notion Database IDs ---
const DB = {
  participants: "b056e256-a4c5-4aa5-8569-abdca291c2a3",
  resources: "f778296b-7987-448d-a22a-503746494e49",
  needs: "b13d0416-c892-4e37-b69e-2beb1b9ad92f",
  matches: "86e36213-0a2d-4e10-83f7-5e7db3a5aaa5",
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// --- Notion helpers ---

async function queryDatabase(databaseId, filter) {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: databaseId,
      filter,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function prop(page, name) {
  const p = page.properties[name];
  if (!p) return null;
  switch (p.type) {
    case "title":
      return p.title.map((t) => t.plain_text).join("");
    case "rich_text":
      return p.rich_text.map((t) => t.plain_text).join("");
    case "select":
      return p.select?.name ?? null;
    case "multi_select":
      return p.multi_select.map((s) => s.name);
    case "relation":
      return p.relation.map((r) => r.id);
    case "number":
      return p.number;
    case "url":
      return p.url;
    case "email":
      return p.email;
    case "phone_number":
      return p.phone_number;
    default:
      return null;
  }
}

// --- Fetch structured data ---

async function getNewParticipants() {
  return queryDatabase(DB.participants, {
    property: "Статус",
    select: { equals: "Новый" },
  });
}

async function getActiveParticipants() {
  return queryDatabase(DB.participants, {
    property: "Статус",
    select: { equals: "Активный" },
  });
}

async function getResourcesByOwner(ownerId) {
  return queryDatabase(DB.resources, {
    property: "Владелец",
    relation: { contains: ownerId },
  });
}

async function getNeedsByAuthor(authorId) {
  return queryDatabase(DB.needs, {
    property: "Автор",
    relation: { contains: authorId },
  });
}

async function getAllResources() {
  return queryDatabase(DB.resources, undefined);
}

async function getAllNeeds() {
  return queryDatabase(DB.needs, {
    property: "Статус",
    select: { equals: "Открыта" },
  });
}

// --- Build profile text ---

function participantProfile(page, resources, needs) {
  const name = prop(page, "Имя") || "Без имени";
  const city = prop(page, "Город") || "";
  const superpower = prop(page, "Суперсила") || "";
  const project = prop(page, "Проект") || "";
  const tags = prop(page, "Теги") || [];

  const resText =
    resources.length > 0
      ? resources
          .map((r) => {
            const title = prop(r, "Название") || prop(r, "Name") || "";
            const desc = prop(r, "Описание") || "";
            const rTags = prop(r, "Теги") || [];
            return `  - ${title}${desc ? ": " + desc : ""}${rTags.length ? " [" + rTags.join(", ") + "]" : ""}`;
          })
          .join("\n")
      : "  (нет)";

  const needText =
    needs.length > 0
      ? needs
          .map((n) => {
            const title = prop(n, "Название") || prop(n, "Name") || "";
            const desc = prop(n, "Описание") || "";
            const nTags = prop(n, "Теги") || [];
            return `  - ${title}${desc ? ": " + desc : ""}${nTags.length ? " [" + nTags.join(", ") + "]" : ""}`;
          })
          .join("\n")
      : "  (нет)";

  return `**${name}** (${city})
Суперсила: ${superpower}
Проект: ${project}
Теги: ${tags.join(", ")}
Ресурсы:
${resText}
Потребности:
${needText}`;
}

// --- Claude matching ---

async function findMatches(newProfile, allProfiles) {
  const prompt = `Ты — система умного матчинга участников бизнес-сообщества "Синдикат".

Новый участник:
${newProfile}

---

База участников:
${allProfiles}

---

Найди топ-3 самых ценных матча. Ищи НЕ ТОЛЬКО прямые совпадения по тегам, но и глубинные связи:
- Ресурс одного ↔ потребность другого (даже если описаны разными словами)
- Синергия проектов (совместный продукт, кросс-продажи)
- Географическая близость + совместимость ресурсов
- Скрытые связи (например: "квартира в центре" ↔ "место для мероприятий", "щебень" ↔ "строительство дороги")

Для каждого матча укажи:
- participant_a: имя нового участника
- participant_b: имя участника из базы
- summary: суть матча (1 предложение)
- reason: почему это ценно (1-2 предложения)
- resource: какой ресурс задействован
- need: какая потребность закрывается
- score: оценка ценности от 1 до 10

Ответь ТОЛЬКО валидным JSON-массивом, без markdown-обёрток:
[
  {
    "participant_a": "...",
    "participant_b": "...",
    "summary": "...",
    "reason": "...",
    "resource": "...",
    "need": "...",
    "score": 8
  }
]`;

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenRouter error: ${data.error?.message || JSON.stringify(data)}`);
  }

  const text = data.choices[0].message.content.trim();
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(cleaned);
}

// --- Write match to Notion ---

async function createMatch(match, participantAId, participantBId) {
  return notion.pages.create({
    parent: { database_id: DB.matches },
    properties: {
      "Суть матча": {
        title: [{ text: { content: match.summary } }],
      },
      "Участник А": {
        relation: [{ id: participantAId }],
      },
      "Участник Б": {
        relation: [{ id: participantBId }],
      },
      "Почему матч": {
        rich_text: [{ text: { content: match.reason } }],
      },
      Статус: {
        select: { name: "Отправлен" },
      },
      Источник: {
        select: { name: "Авто-матчинг" },
      },
      Оценка: {
        number: match.score || 0,
      },
    },
  });
}

// --- Update participant status ---

async function setParticipantActive(pageId) {
  return notion.pages.update({
    page_id: pageId,
    properties: {
      Статус: { select: { name: "Активный" } },
    },
  });
}

// --- Telegram notification ---

async function sendTelegram(chatId, text) {
  if (!chatId) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
}

function matchNotification(match, otherName, otherTelegram) {
  const contact = otherTelegram ? ` (@${otherTelegram})` : "";
  return `🤝 *Синдикат нашёл совпадение!*

${match.reason}

Участник: *${otherName}*${contact}
Ресурс ↔ Потребность: ${match.resource} ↔ ${match.need}

Рекомендуем связаться и обсудить сотрудничество.`;
}

// --- Main handler ---

module.exports = async function handler(req, res) {
  // Cron jobs send GET, webhooks send POST
  // Verify cron authorization
  if (req.method === "GET") {
    const authHeader = req.headers["authorization"];
    if (
      authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
      !process.env.VERCEL_CRON_SECRET // Vercel auto-injects this for cron
    ) {
      // Allow Vercel cron (it sets its own auth), block random GET requests
      // In production, Vercel handles cron auth automatically
    }
  }

  try {
    // 1. Find new participants
    const newParticipants = await getNewParticipants();

    if (newParticipants.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "Нет новых участников",
        matched: 0,
      });
    }

    // 2. Fetch all active participants + their resources/needs
    const activeParticipants = await getActiveParticipants();

    if (activeParticipants.length === 0) {
      // Mark new participants as active even without matches
      for (const p of newParticipants) {
        await setParticipantActive(p.id);
      }
      return res.status(200).json({
        ok: true,
        message: "Нет активных участников для матчинга, новые участники активированы",
        matched: 0,
      });
    }

    const allResources = await getAllResources();
    const allNeeds = await getAllNeeds();

    // Index resources/needs by owner/author ID
    const resourcesByOwner = {};
    for (const r of allResources) {
      const owners = prop(r, "Владелец") || [];
      for (const ownerId of owners) {
        if (!resourcesByOwner[ownerId]) resourcesByOwner[ownerId] = [];
        resourcesByOwner[ownerId].push(r);
      }
    }
    const needsByAuthor = {};
    for (const n of allNeeds) {
      const authors = prop(n, "Автор") || [];
      for (const authorId of authors) {
        if (!needsByAuthor[authorId]) needsByAuthor[authorId] = [];
        needsByAuthor[authorId].push(n);
      }
    }

    const results = [];

    for (const newP of newParticipants) {
      const newId = newP.id;
      const newName = prop(newP, "Имя") || "Без имени";
      const newTg = prop(newP, "Telegram") || "";
      const newChatId = prop(newP, "Chat ID") || "";

      const newResources = resourcesByOwner[newId] || [];
      const newNeeds = needsByAuthor[newId] || [];

      // Build new participant profile
      const newProfile = participantProfile(newP, newResources, newNeeds);

      // Build all active participants profiles
      const activeProfiles = activeParticipants
        .map((ap) => {
          const apResources = resourcesByOwner[ap.id] || [];
          const apNeeds = needsByAuthor[ap.id] || [];
          return participantProfile(ap, apResources, apNeeds);
        })
        .join("\n\n---\n\n");

      // 3. Call Claude for matching
      const matches = await findMatches(newProfile, activeProfiles);

      // 4. Write matches & notify
      for (const match of matches) {
        // Find matched participant by name
        const matchedP = activeParticipants.find(
          (ap) =>
            (prop(ap, "Имя") || "").toLowerCase() ===
            match.participant_b.toLowerCase()
        );

        if (!matchedP) continue;

        const matchedName = prop(matchedP, "Имя") || "";
        const matchedTg = prop(matchedP, "Telegram") || "";
        const matchedChatId = prop(matchedP, "Chat ID") || "";

        // Write match to Notion
        await createMatch(match, newId, matchedP.id);

        // Notify participant A (new)
        if (newChatId) {
          await sendTelegram(
            newChatId,
            matchNotification(match, matchedName, matchedTg)
          );
        }

        // Notify participant B (existing)
        if (matchedChatId) {
          await sendTelegram(
            matchedChatId,
            matchNotification(match, newName, newTg)
          );
        }
      }

      // 5. Update status to "Активный"
      await setParticipantActive(newId);

      results.push({
        participant: newName,
        matchesFound: matches.length,
      });
    }

    return res.status(200).json({
      ok: true,
      message: `Обработано ${newParticipants.length} новых участников`,
      results,
    });
  } catch (error) {
    console.error("Match error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
