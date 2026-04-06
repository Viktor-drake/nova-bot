// OpenAI TTS — Nova voice (soft, playful, sensual)
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TTS_MODEL = "tts-1-hd";
const TTS_VOICE = "shimmer"; // мягкий, женственный, чуть с придыханием

async function synthesizeVoice(text) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing");

  // Telegram voice limit: 1MB. ~4000 chars safe for tts-1-hd opus.
  const clean = (text || "").replace(/[*_`~#>\[\]()]/g, "").slice(0, 4000);
  if (!clean.trim()) throw new Error("Empty TTS input");

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: clean,
      response_format: "opus", // ogg/opus — нативно для Telegram voice
      speed: 1.0,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI TTS ${res.status}: ${err.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { synthesizeVoice };
