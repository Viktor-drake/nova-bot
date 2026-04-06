// Voice transcription via OpenRouter (Gemini 2.5 Flash audio input)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OR_KEY = process.env.OPENROUTER_API_KEY;
const VOICE_MODEL = "google/gemini-2.5-flash";

async function transcribeVoice(fileId) {
  if (!TG_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN missing");
  if (!OR_KEY) throw new Error("OPENROUTER_API_KEY missing");

  // 1. Get file path from Telegram
  const infoRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error(`getFile failed: ${JSON.stringify(info).slice(0,200)}`);
  const filePath = info.result.file_path;

  // 2. Download audio bytes
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
  if (!fileRes.ok) throw new Error(`download failed: ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const b64 = buf.toString("base64");

  // 3. Send to Gemini via OpenRouter
  const body = {
    model: VOICE_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Расшифруй аудио на русском языке. Верни ТОЛЬКО текст расшифровки, без комментариев, без префиксов, без кавычек." },
          { type: "input_audio", input_audio: { data: b64, format: "ogg" } },
        ],
      },
    ],
    max_tokens: 2000,
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OR_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`Empty transcription: ${JSON.stringify(data).slice(0, 300)}`);
  return text;
}

module.exports = { transcribeVoice };