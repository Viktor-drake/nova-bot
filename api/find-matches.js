// POST /api/find-matches
// Scans the community and writes potential matches to Notion "🔗 Матчи"
// Can be triggered manually or via cron.

const { Client } = require("@notionhq/client");
const { getCommunitySnapshot, DB } = require("../lib/notion");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const MATCHING_PROMPT = `Ты — аналитик сообщества NextGen Club. Твоя задача — найти потенциальные связки между участниками, где один может помочь другому, и это может привести к сделке или взаимовыгодному сотрудничеству.

Правила:
1. Ищи НЕОЧЕВИДНЫЕ связки: не только прямое "у одного есть X, другой ищет X", но и цепочки типа "у одного есть пространство → другой делает подкасты → вместе они могут запустить медиа-продукт"
2. Для каждого матча укажи:
   - Участник А (кто даёт ресурс)
   - Участник Б (кому может быть полезно)
   - Суть матча (1-2 предложения)
   - Почему это хорошая связка (конкретика, не вода)
   - Оценка потенциала: high / medium / low
3. Минимум 5, максимум 15 матчей — только реально сильные
4. НЕ выдумывай факты — используй только данные из базы
5. Если связка слабая или надуманная — не включай
6. Формат ответа — строго JSON массив, без markdown

Формат одного матча:
{
  "participant_a": "Имя (как в базе)",
  "participant_b": "Имя (как в базе)",
  "resource_hint": "краткое описание ресурса из базы",
  "title": "короткий заголовок матча",
  "reason": "почему это хорошая связка, с конкретикой",
  "potential": "high" | "medium" | "low"
}`;

module.exports = async function handler(req, res) {
  // Auth via secret (either header for Vercel cron or query for manual)
  const isVercelCron = req.headers["x-vercel-cron"] !== undefined;
  const secret = req.query?.secret || req.headers["x-api-secret"];
  if (!isVercelCron && secret !== process.env.API_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const t0 = Date.now();
  try {
    // 1. Load community snapshot
    console.log("[find-matches] loading snapshot...");
    const snapshot = await getCommunitySnapshot();
    console.log(`[find-matches] snapshot ${snapshot.length} chars`);

    // 2. Ask Claude to find matches
    console.log("[find-matches] calling Claude...");
    const aiRes = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        max_tokens: 4000,
        messages: [
          { role: "system", content: MATCHING_PROMPT },
          {
            role: "user",
            content: `Вот база участников и их ресурсов:\n\n${snapshot}\n\nНайди лучшие потенциальные матчи и верни JSON массив.`,
          },
        ],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      throw new Error(`OpenRouter: ${aiData.error?.message || JSON.stringify(aiData)}`);
    }
    const reply = aiData.choices[0].message.content;
    console.log(`[find-matches] AI reply ${reply.length} chars`);

    // 3. Parse JSON from response
    let matches;
    try {
      const jsonMatch = reply.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found");
      matches = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error("[find-matches] parse error:", e.message, "raw:", reply.slice(0, 500));
      return res.status(500).json({ error: "Failed to parse AI response", raw: reply.slice(0, 500) });
    }

    // 4. Load participants to resolve names → IDs
    const partsRes = await notion.databases.query({
      database_id: DB.participants,
      page_size: 100,
    });
    const nameToId = {};
    for (const p of partsRes.results) {
      const title = p.properties["Имя"]?.title?.map((t) => t.plain_text).join("") || "";
      if (title) nameToId[title.trim()] = p.id;
    }

    // 5. Write matches to Notion
    const written = [];
    const skipped = [];
    for (const m of matches) {
      const aId = nameToId[m.participant_a?.trim()];
      const bId = nameToId[m.participant_b?.trim()];
      if (!aId || !bId) {
        skipped.push({ match: m.title, reason: `unknown name: ${!aId ? m.participant_a : m.participant_b}` });
        continue;
      }

      try {
        await notion.pages.create({
          parent: { database_id: DB.matches },
          properties: {
            "Суть матча": {
              title: [{ text: { content: m.title?.slice(0, 200) || "Без названия" } }],
            },
            "Участник А": { relation: [{ id: aId }] },
            "Участник Б": { relation: [{ id: bId }] },
            "Почему матч": {
              rich_text: [{ text: { content: (m.reason || "").slice(0, 2000) } }],
            },
            Статус: { select: { name: "Отправлен" } },
            Источник: { select: { name: "Авто-матчинг" } },
            Дата: { date: { start: new Date().toISOString().split("T")[0] } },
          },
        });
        written.push(m.title);
      } catch (e) {
        skipped.push({ match: m.title, reason: e.message });
      }
    }

    const ms = Date.now() - t0;
    console.log(`[find-matches] done in ${ms}ms: ${written.length} written, ${skipped.length} skipped`);
    return res.status(200).json({
      ok: true,
      ms,
      found: matches.length,
      written: written.length,
      skipped: skipped.length,
      matches: written,
      errors: skipped,
    });
  } catch (error) {
    console.error("[find-matches] ERROR:", error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
