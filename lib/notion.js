const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// --- Database IDs ---
const DB = {
  participants: "b056e256-a4c5-4aa5-8569-abdca291c2a3",
  resources: "f778296b-7987-448d-a22a-503746494e49",
  needs: "b13d0416-c892-4e37-b69e-2beb1b9ad92f",
  matches: "86e36213-0a2d-4e10-83f7-5e7db3a5aaa5",
  dialogs: null, // will be set after creating the database
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

module.exports = {
  notion,
  DB,
  prop,
  queryDatabase,
  findParticipantByChatId,
  saveMessage,
  getRecentMessages,
  getParticipantProfile,
};
