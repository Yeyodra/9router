export default {
  id: "tasklet",
  alias: "tl",
  uiAlias: "tl",
  display: {
    name: "Tasklet",
    icon: "task_alt",
    color: "#7C3AED",
    textIcon: "TL",
    website: "https://tasklet.ai",
    notice: {
      signupUrl: "https://tasklet.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.tasklet.ai/api/sendChatMessage",
    format: "openai",
  },
  models: [
    // Claude
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4.8-fast", name: "Claude Opus 4.8 Fast" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    // GPT
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.5-fast", name: "GPT 5.5 Fast" },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    // Gemini
    { id: "gemini-flash-3-preview", name: "Gemini Flash 3 Preview" },
    { id: "gemini-flash-3.5", name: "Gemini Flash 3.5" },
    { id: "gemini-flash-3.6", name: "Gemini Flash 3.6" },
    { id: "gemini-flash-lite-3.1", name: "Gemini Flash Lite 3.1" },
    { id: "gemini-flash-lite-3.5", name: "Gemini Flash Lite 3.5" },
    { id: "gemini-pro-3.1-preview", name: "Gemini Pro 3.1 Preview" },
    // Other
    { id: "grok-4.5", name: "Grok 4.5" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "muse-spark-1.1", name: "Muse Spark 1.1" },
  ],
};
