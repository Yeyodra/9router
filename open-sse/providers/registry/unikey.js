export default {
  id: "unikey",
  priority: 75,
  alias: "yk",
  aliases: [
    "getunikey",
    "guk",
    "uk",
  ],
  uiAlias: "yk",
  display: {
    name: "UniKey",
    icon: "key",
    color: "#6366F1",
    textIcon: "YK",
    website: "https://www.getunikey.ai",
    notice: {
      text: "OpenAI-compatible gateway (New-API). Chat Completions via Bearer API key.",
      apiKeyUrl: "https://www.getunikey.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://www.getunikey.ai/v1/chat/completions",
    validateUrl: "https://www.getunikey.ai/v1/models",
    thinkingFormat: "openai",
    // Image gen sometimes hits CF 504 HTML pages — retry same key before account rotate.
    retry: {
      502: { attempts: 3, delayMs: 3000 },
      503: { attempts: 3, delayMs: 2000 },
      504: { attempts: 3, delayMs: 4000 },
    },
    usage: {
      // Bearer: OpenAI-compat billing + New-API per-token usage
      billing: "https://www.getunikey.ai/v1/dashboard/billing/usage",
      token: "https://www.getunikey.ai/api/usage/token",
    },
  },
  features: {
    usage: true,
    usageApikey: true,
  },
  // Curated chat-safe seed (MODELS.md 2026-07-22). Live catalogue via modelsFetcher;
  // passthroughModels accepts any id returned by GET /v1/models.
  models: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-5.6", name: "GPT-5.6" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "x-ai/grok-4.3", name: "Grok 4.3" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    { id: "z-ai/glm-5.1", name: "GLM 5.1" },
    { id: "z-ai/glm-5-turbo", name: "GLM 5 Turbo" },
    { id: "qwen/qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "qwen/qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen/qwen3.6-plus", name: "Qwen3.6 Plus" },
    { id: "qwen/qwen3.6-flash", name: "Qwen3.6 Flash" },
    // Image gen via POST /v1/images/generations (Bearer). Live probe 2026-07-23.
    { id: "openai/gpt-5.4-image-2", name: "GPT 5.4 Image 2", kind: "image", params: ["n", "size"] },
    { id: "google/gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", kind: "image", params: ["n", "size"] },
    { id: "google/gemini-3-pro-image", name: "Gemini 3 Pro Image", kind: "image", params: ["n", "size"] },
    // Catalog alias; may 403 when account gift quota is exhausted (pre-deduct).
    { id: "gpt-image-2", name: "GPT Image 2", kind: "image", params: ["n", "size"] },
  ],
  serviceKinds: ["llm", "imageToText", "image"],
  imageConfig: {
    baseUrl: "https://www.getunikey.ai/v1/images/generations",
  },
  modelsFetcher: { url: "https://www.getunikey.ai/v1/models", type: "openai" },
  passthroughModels: true,
};
