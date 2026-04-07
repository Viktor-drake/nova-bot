// Идемпотентная миграция схемы Notion для NextGen Club.
// Запуск: node scripts/notion-migrate.js
//
// ПРИНЦИП: schema as code. Любые изменения структуры Notion DB
// добавляются сюда. Скрипт безопасно перезапускать — он
// проверяет наличие полей и добавляет только недостающие.
//
// Без зависимостей: работает на встроенном fetch (Node 18+).

const fs = require("fs");
const path = require("path");

// --- Загрузка .env.local без зависимостей ---
function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\r\n]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

async function notionApi(method, url, body) {
  const res = await fetch(`https://api.notion.com/v1${url}`, {
    method,
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Notion ${method} ${url} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

// === КАТАЛОГ МИГРАЦИЙ ===
// Дописывай новые миграции в массив. Каждая = объект:
// { db: '<id>', name: '<имя для лога>', properties: { ...patch... } }
const MIGRATIONS = [
  {
    name: "👤 Участники Синдиката — лимиты Новы",
    db: "b056e256-a4c5-4aa5-8569-abdca291c2a3",
    properties: {
      msgs_today: { number: { format: "number" } },
      voice_today: { number: { format: "number" } },
      tokens_today: { number: { format: "number" } },
      quota_reset: { date: {} },
      "Роль": {
        select: {
          options: [
            { name: "Гость", color: "gray" },
            { name: "Участник", color: "green" },
            { name: "VIP", color: "purple" },
            { name: "Founder", color: "red" },
          ],
        },
      },
    },
  },
];

async function runMigration(m) {
  console.log(`\n→ ${m.name}`);
  const db = await notionApi("GET", `/databases/${m.db}`);
  const existing = new Set(Object.keys(db.properties));
  const toAdd = {};
  for (const [key, val] of Object.entries(m.properties)) {
    if (existing.has(key)) {
      console.log(`  ✓ уже есть: ${key}`);
    } else {
      toAdd[key] = val;
      console.log(`  + добавляю: ${key}`);
    }
  }
  if (Object.keys(toAdd).length === 0) {
    console.log("  (всё на месте)");
    return;
  }
  await notionApi("PATCH", `/databases/${m.db}`, { properties: toAdd });
  console.log(`  ✅ обновлено: ${Object.keys(toAdd).join(", ")}`);
}

(async () => {
  if (!NOTION_TOKEN) {
    console.error("❌ NOTION_TOKEN не найден в .env.local");
    process.exit(1);
  }
  console.log("🔧 Notion schema migration");
  for (const m of MIGRATIONS) {
    try {
      await runMigration(m);
    } catch (e) {
      console.error(`❌ ${m.name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log("\n✨ done");
})();
