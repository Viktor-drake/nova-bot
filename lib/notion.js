const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// --- Database IDs ---
const DB = {
  participants: "b056e256-a4c5-4aa5-8569-abdca291c2a3",
  resources: "f778296b-7987-448d-a22a-503746494e49",
  needs: "b13d0416-c892-4e37-b69e-2beb1b9ad92f",
  matches: "86e36213-0a2d-4e10-83f7-5e7db3a5aaa5",
  dialogs: "f228f7e0-1b0a-42ca-80f4-a170057613d0",
};

// --- Property reader ---
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
    case "checkbox":
      return p.checkbox;
    default:
      return null;
  }
}

// --- Query helper with pagination ---
async function queryDatabase(databaseId, filter) {
  const pages = [];
  let cursor;
  do {
    const opts = {
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    };
    if (filter) opts.filter = filter;
    const res = await notion.databases.query(opts);
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// --- Find participant by chat_id ---
async function findParticipantByChatId(chatId) {
  const results = await queryDatabase(DB.participants, {
    property: "Chat ID",
    rich_text: { equals: String(chatId) },
  });
  return results[0] || null;
}

// --- Ensure participant exists by chat_id (create stub if not) ---
async function ensureParticipantByChat(chatId, fallbackName, telegramHandle) {
  let p = await findParticipantByChatId(chatId);
  if (p) return p;
  const properties = {
    Имя: { title: [{ text: { content: fallbackName || `Гость ${chatId}` } }] },
    "Chat ID": { rich_text: [{ text: { content: String(chatId) } }] },
    Статус: { select: { name: "Новый" } },
    Режим: { select: { name: "nova" } },
    "Дата регистрации": { date: { start: new Date().toISOString().slice(0, 10) } },
  };
  if (telegramHandle) {
    properties.Telegram = { rich_text: [{ text: { content: telegramHandle } }] };
  }
  return notion.pages.create({
    parent: { database_id: DB.participants },
    properties,
  });
}

// --- Toggle voice off (true = голос отключён) ---
async function setParticipantVoiceOff(participantId, off) {
  try {
    return await notion.pages.update({
      page_id: participantId,
      properties: { "Голос выкл": { checkbox: !!off } },
    });
  } catch (e) {
    console.warn(`[notion] setParticipantVoiceOff failed (поле "Голос выкл" не создано?): ${e.message}`);
  }
}

// --- Set participant mode (nova / anketa) ---
async function setParticipantMode(participantId, mode, activeBlock) {
  const properties = { Режим: { select: { name: mode } } };
  if (activeBlock !== undefined) {
    properties["Активный блок"] = activeBlock ? { select: { name: activeBlock } } : { select: null };
  }
  return notion.pages.update({ page_id: participantId, properties });
}

// --- Create resource linked to participant ---
async function createResource({ ownerId, описание, тип, город, условия, теги, детали }) {
  const properties = {
    Описание: { title: [{ text: { content: (описание || "Без названия").slice(0, 200) } }] },
    Владелец: { relation: [{ id: ownerId }] },
  };
  if (тип) properties["Тип"] = { select: { name: тип } };
  if (город) properties["Город"] = { select: { name: город } };
  if (условия) properties["Условия"] = { select: { name: условия } };
  if (теги && теги.length) properties["Теги"] = { multi_select: теги.map((t) => ({ name: t })) };
  if (детали) properties["Детали"] = { rich_text: [{ text: { content: детали.slice(0, 1900) } }] };
  return notion.pages.create({ parent: { database_id: DB.resources }, properties });
}

// --- Create need linked to participant ---
async function createNeed({ authorId, описание, тип, город, срочность, теги, детали }) {
  const properties = {
    Описание: { title: [{ text: { content: (описание || "Без названия").slice(0, 200) } }] },
    Автор: { relation: [{ id: authorId }] },
    Статус: { select: { name: "Открыта" } },
  };
  if (тип) properties["Тип"] = { select: { name: тип } };
  if (город) properties["Город"] = { select: { name: город } };
  if (срочность) properties["Срочность"] = { select: { name: срочность } };
  if (теги && теги.length) properties["Теги"] = { multi_select: теги.map((t) => ({ name: t })) };
  if (детали) properties["Детали"] = { rich_text: [{ text: { content: детали.slice(0, 1900) } }] };
  return notion.pages.create({ parent: { database_id: DB.needs }, properties });
}

// --- Update participant profile fields ---
async function updateParticipantProfile(participantId, { имя, город, ниши, суперсила, проект, главныйРезультат, часовБесплатно }) {
  const properties = {};
  if (имя) properties["Имя"] = { title: [{ text: { content: имя } }] };
  if (город) properties["Город"] = { select: { name: город } };
  if (ниши && ниши.length) properties["Ниши"] = { multi_select: ниши.map((n) => ({ name: n })) };
  if (суперсила) properties["Суперсила"] = { rich_text: [{ text: { content: суперсила.slice(0, 1900) } }] };
  if (проект) properties["Текущий проект"] = { rich_text: [{ text: { content: проект.slice(0, 1900) } }] };
  if (главныйРезультат) properties["Главный результат"] = { rich_text: [{ text: { content: главныйРезультат.slice(0, 1900) } }] };
  if (typeof часовБесплатно === "number") properties["Часов бесплатно/мес"] = { number: часовБесплатно };
  if (Object.keys(properties).length === 0) return null;
  return notion.pages.update({ page_id: participantId, properties });
}

// --- Save dialog message ---
async function saveMessage(chatId, role, text, participantId) {
  if (!DB.dialogs) return;
  const properties = {
    Текст: { title: [{ text: { content: text.slice(0, 2000) } }] },
    Роль: { select: { name: role } },
    "Chat ID": { rich_text: [{ text: { content: String(chatId) } }] },
    Дата: { date: { start: new Date().toISOString() } },
  };
  if (participantId) {
    properties["Участник"] = { relation: [{ id: participantId }] };
  }
  return notion.pages.create({
    parent: { database_id: DB.dialogs },
    properties,
  });
}

// --- Load recent dialog history ---
async function getRecentMessages(chatId, limit = 20) {
  if (!DB.dialogs) return [];
  const results = await notion.databases.query({
    database_id: DB.dialogs,
    filter: {
      property: "Chat ID",
      rich_text: { equals: String(chatId) },
    },
    sorts: [{ property: "Дата", direction: "descending" }],
    page_size: limit,
  });
  return results.results
    .map((page) => ({
      role: prop(page, "Роль") === "assistant" ? "assistant" : "user",
      content: prop(page, "Текст") || "",
    }))
    .reverse();
}

// --- Get participant profile with resources ---
async function getParticipantProfile(participantPage) {
  const id = participantPage.id;
  const resources = await queryDatabase(DB.resources, {
    property: "Владелец",
    relation: { contains: id },
  });
  const needs = await queryDatabase(DB.needs, {
    property: "Автор",
    relation: { contains: id },
  });

  const name = prop(participantPage, "Имя") || "Без имени";
  const city = prop(participantPage, "Город") || "";
  const superpower = prop(participantPage, "Суперсила") || "";
  const project = prop(participantPage, "Проект") || "";

  const resList = resources.map(
    (r) => `- ${prop(r, "Название") || prop(r, "Name") || ""}: ${prop(r, "Описание") || ""}`
  );
  const needsList = needs.map(
    (n) => `- ${prop(n, "Название") || prop(n, "Name") || ""}: ${prop(n, "Описание") || ""}`
  );

  return `Имя: ${name}
Город: ${city}
Суперсила: ${superpower}
Проект: ${project}
Ресурсы: ${resList.length ? "\n" + resList.join("\n") : "не указаны"}
Потребности: ${needsList.length ? "\n" + needsList.join("\n") : "не указаны"}`;
}

// --- Community snapshot cache (in-memory, ~5 min TTL) ---
let snapshotCache = { text: null, ts: 0 };
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

// --- Build a text snapshot of the entire community for Claude context ---
async function getCommunitySnapshot() {
  const now = Date.now();
  if (snapshotCache.text && now - snapshotCache.ts < SNAPSHOT_TTL_MS) {
    return snapshotCache.text;
  }

  // Fetch participants and resources in parallel
  const [participants, resources, needs] = await Promise.all([
    queryDatabase(DB.participants),
    queryDatabase(DB.resources),
    queryDatabase(DB.needs).catch(() => []),
  ]);

  // Index participants by id (skip "Новый" — недозаполненные не лезут в матчи)
  const byId = {};
  for (const p of participants) {
    const status = prop(p, "Статус");
    if (status === "Новый") continue;
    const name = prop(p, "Имя") || "Без имени";
    const tg = prop(p, "Telegram") || "";
    const city = prop(p, "Город") || "";
    const niches = prop(p, "Ниши") || [];
    const power = prop(p, "Суперсила") || "";
    const project = prop(p, "Текущий проект") || "";
    byId[p.id] = {
      name,
      tg,
      city,
      niches: Array.isArray(niches) ? niches.join(", ") : "",
      power,
      project,
      resources: [],
      needs: [],
    };
  }

  // Attach resources to owners
  for (const r of resources) {
    const ownerIds = prop(r, "Владелец") || [];
    const desc = prop(r, "Описание") || "";
    const type = prop(r, "Тип") || "";
    const city = prop(r, "Город") || "";
    const tags = prop(r, "Теги") || [];
    const terms = prop(r, "Условия") || "";
    const details = prop(r, "Детали") || "";
    const parts = [`[${type}] ${desc}`];
    if (city) parts.push(`Город: ${city}`);
    if (tags.length) parts.push(`Теги: ${tags.join(", ")}`);
    if (terms) parts.push(`Условия: ${terms}`);
    if (details) parts.push(`Детали: ${details}`);
    const line = parts.join(" | ");
    for (const id of ownerIds) {
      if (byId[id]) byId[id].resources.push(line);
    }
  }

  // Attach needs to authors
  for (const n of needs) {
    const authorIds = prop(n, "Автор") || prop(n, "Владелец") || [];
    const desc = prop(n, "Описание") || prop(n, "Название") || "";
    const type = prop(n, "Тип") || "";
    const line = `[${type}] ${desc}`;
    for (const id of authorIds) {
      if (byId[id]) byId[id].needs.push(line);
    }
  }

  // Render compact text snapshot
  const lines = [];
  for (const id of Object.keys(byId)) {
    const p = byId[id];
    if (!p.name || p.name === "Без имени") continue;
    lines.push(`### ${p.name}${p.tg ? " (@" + p.tg.replace("@", "") + ")" : ""}`);
    if (p.city) lines.push(`Город: ${p.city}`);
    if (p.niches) lines.push(`Ниши: ${p.niches}`);
    if (p.power) lines.push(`Суперсила: ${p.power}`);
    if (p.project) lines.push(`Проект: ${p.project}`);
    if (p.resources.length) {
      lines.push("Ресурсы и предложения:");
      p.resources.forEach((r) => lines.push("  " + r));
    }
    if (p.needs.length) {
      lines.push("Потребности:");
      p.needs.forEach((n) => lines.push("  " + n));
    }
    lines.push("");
  }

  const text = lines.join("\n").trim();
  snapshotCache = { text, ts: now };
  return text;
}

// --- Nova global state (cold start fix) ---
// Хранится как специальная строка в participants DB с Chat ID = "NOVA_STATE_V1"
// Поля: tokens_today (float → spentUsd), quota_reset (date → YYYY-MM-01)

const NOVA_STATE_CHAT_ID = "NOVA_STATE_V1";

async function loadMonthSpend() {
  try {
    const results = await queryDatabase(DB.participants, {
      property: "Chat ID",
      rich_text: { equals: NOVA_STATE_CHAT_ID },
    });
    const row = results[0];
    if (!row) return { spentUsd: 0, monthKey: null };
    const spentUsd = row.properties?.tokens_today?.number || 0;
    const resetDate = row.properties?.quota_reset?.date?.start || null;
    const monthKey = resetDate ? resetDate.slice(0, 7) : null; // "YYYY-MM"
    return { spentUsd, monthKey, rowId: row.id };
  } catch (e) {
    console.warn("[notion] loadMonthSpend failed:", e.message);
    return { spentUsd: 0, monthKey: null };
  }
}

async function saveMonthSpend(spentUsd, monthKey) {
  try {
    const results = await queryDatabase(DB.participants, {
      property: "Chat ID",
      rich_text: { equals: NOVA_STATE_CHAT_ID },
    });
    const row = results[0];
    const properties = {
      tokens_today: { number: spentUsd },
      quota_reset: { date: { start: monthKey + "-01" } },
    };
    if (row) {
      await notion.pages.update({ page_id: row.id, properties });
    } else {
      await notion.pages.create({
        parent: { database_id: DB.participants },
        properties: {
          Имя: { title: [{ text: { content: "NOVA_GLOBAL_STATE" } }] },
          "Chat ID": { rich_text: [{ text: { content: NOVA_STATE_CHAT_ID } }] },
          Статус: { select: { name: "Новый" } },
          ...properties,
        },
      });
    }
  } catch (e) {
    console.warn("[notion] saveMonthSpend failed:", e.message);
  }
}

module.exports = {
  notion,
  DB,
  prop,
  queryDatabase,
  findParticipantByChatId,
  ensureParticipantByChat,
  setParticipantMode,
  setParticipantVoiceOff,
  createResource,
  createNeed,
  updateParticipantProfile,
  saveMessage,
  getRecentMessages,
  getParticipantProfile,
  getCommunitySnapshot,
  loadMonthSpend,
  saveMonthSpend,
};
