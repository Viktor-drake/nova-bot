// Voice transcription via OpenAI Whisper API (direct, no OpenRouter)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

async function transcribeVoice(fileId) {
  if (!TG_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN missing");
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing — add it to Vercel env vars");

  // 1. Get file path from Telegram
  const infoRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error(`getFile failed: ${JSON.stringify(info).slice(0, 200)}`);
  const filePath = info.result.file_path;

  // 2. Download audio bytes
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
  if (!fileRes.ok) throw new Error(`download failed: ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  // 3. Send to OpenAI Whisper via multipart form
  const formData = new FormData();
  formData.append("file", new Blob([buf], { type: "audio/ogg" }), "audio.ogg");
  formData.append("model", "whisper-1");
  formData.append("language", "ru");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_KEY}` },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Whisper ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.text?.trim();
  if (!text) throw new Error(`Empty transcription: ${JSON.stringify(data).slice(0, 300)}`);
  return text;
}

module.exports = { transcribeVoice };