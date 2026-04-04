// Test endpoint: GET /api/test?secret=YOUR_API_SECRET
// Checks: OpenRouter, Telegram, Notion connections

module.exports = async function handler(req, res) {
  if (req.query.secret !== process.env.API_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const results = {};

  // 1. Test OpenRouter
  try {
    const start = Date.now();
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        max_tokens: 50,
        messages: [{ role: "user", content: "Say 'ok' in one word" }],
      }),
    });
    const data = await response.json();
    results.openrouter = {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - start,
      reply: data.choices?.[0]?.message?.content || data.error?.message || JSON.stringify(data),
    };
  } catch (e) {
    results.openrouter = { ok: false, error: e.message };
  }

  // 2. Test Telegram
  try {
    const start = Date.now();
    const response = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`
    );
    const data = await response.json();
    results.telegram = {
      ok: data.ok,
      ms: Date.now() - start,
      bot: data.result?.username,
    };
  } catch (e) {
    results.telegram = { ok: false, error: e.message };
  }

  // 3. Test Notion
  try {
    const start = Date.now();
    const response = await fetch("https://api.notion.com/v1/users/me", {
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
      },
    });
    const data = await response.json();
    results.notion = {
      ok: response.ok,
      ms: Date.now() - start,
      name: data.name || data.message,
    };
  } catch (e) {
    results.notion = { ok: false, error: e.message };
  }

  // 4. Env check
  results.env = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? "set" : "MISSING",
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ? "set" : "MISSING",
    NOTION_TOKEN: process.env.NOTION_TOKEN ? "set" : "MISSING",
    API_SECRET: process.env.API_SECRET ? "set" : "MISSING",
  };

  return res.status(200).json(results);
};
