const { setWebhook } = require("../lib/telegram");

// One-time setup: registers webhook URL with Telegram
// Call once after deploy: GET https://your-app.vercel.app/api/setup?secret=YOUR_API_SECRET
module.exports = async function handler(req, res) {
  const { secret } = req.query;

  if (secret !== process.env.API_SECRET) {
    return res.status(403).json({ error: "Wrong secret" });
  }

  // Auto-detect Vercel URL
  const host =
    req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const protocol = host.includes("localhost") ? "http" : "https";
  const webhookUrl = `${protocol}://${host}/api/webhook`;

  const result = await setWebhook(webhookUrl, process.env.API_SECRET);

  return res.status(200).json({
    ok: true,
    webhook_url: webhookUrl,
    telegram_response: result,
  });
};
