const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Last usage from most recent call (для трекинга лимитов)
let lastUsage = { input: 0, output: 0, model: "" };
function getLastUsage() { return { ...lastUsage }; }

// --- Call AI model via OpenRouter ---
async function chat(messages, options = {}) {
  const {
    model = "anthropic/claude-sonnet-4",
    maxTokens = 2000,
    temperature = 0.7,
  } = options;

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `OpenRouter error: ${data.error?.message || JSON.stringify(data)}`
    );
  }

  lastUsage = {
    input: data.usage?.prompt_tokens || 0,
    output: data.usage?.completion_tokens || 0,
    model,
  };

  return data.choices[0].message.content;
}

// --- Quick helper: system + user message ---
async function ask(systemPrompt, userMessage, options = {}) {
  return chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    options
  );
}

// --- Conversation with history ---
async function converse(systemPrompt, history, userMessage, options = {}) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];
  return chat(messages, options);
}

module.exports = { chat, ask, converse, getLastUsage };
