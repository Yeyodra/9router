// Enter Pro / Converge AI (enter.converge.ai)
// Auth: Bearer ek_... + X-Workspace-ID (from providerSpecificData.workspaceId)
// Cloudflare requires browser-like Origin/Referer/User-Agent fingerprint.
// Model id format: vendor/slug (e.g. "minimax/minimax-m3") — NOT bare slug.
// Note: some models OK in web UI may 502 on ek_ completions (different gateway).

export default {
  id: "enter-converge",
  priority: 75,
  alias: "ec",
  aliases: ["enter", "converge", "enter-pro", "EC"],
  uiAlias: "EC",
  display: {
    name: "Enter Converge",
    icon: "hub",
    color: "#6366F1",
    textIcon: "EC",
    website: "https://enter.converge.ai",
    notice: {
      apiKeyUrl: "https://enter.converge.ai",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.enter.pro/code/api/v1/chat/completions",
    validateUrl: "https://api.enter.pro/code/api/v1/ai-capability/models",
    headers: {
      "Origin": "https://enter.converge.ai",
      "Referer": "https://enter.converge.ai/",
      // Browser-like UA required — CF 1010 403 without it.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: ["enterConvergeWorkspace"],
    },
    retry: { 502: { attempts: 3 } },
    usage: {
      // Path template; handler builds full URL with workspaceId.
      credits: "https://api.enter.pro/code/api/v1/workspaces/{workspaceId}/credits",
      dashboard: "https://api.enter.pro/code/api/v1/workspaces/{workspaceId}/credits/dashboard",
    },
  },
  features: {
    usage: true,
    usageApikey: true,
  },
  // Models confirmed OK via ek_ smoke test (Juli 2026).
  // IDs are the exact strings accepted by POST /chat/completions.
  // OpenAI models need max_completion_tokens (handled in paramSupport.js).
  // [502] = visible in web UI but upstream gateway down for ek_ completions.
  models: [
    // OpenAI / GPT family
    { id: "openai/gpt-5.6-sol",   name: "GPT 5.6 Sol" },
    { id: "openai/gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "openai/gpt-5.6-luna",  name: "GPT 5.6 Luna" },
    { id: "openai/gpt-5.5",       name: "GPT 5.5" },
    { id: "openai/gpt-5.4-pro",   name: "GPT 5.4 Pro" },
    { id: "openai/gpt-5.4",       name: "GPT 5.4" },
    { id: "openai/gpt-5.2-pro",   name: "GPT 5.2 Pro" },
    // Anthropic Claude (OK on ek_)
    { id: "anthropic/claude-opus-4.6",   name: "Claude Opus 4.6" },
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    // Project-chat only (502 on /chat/completions, OK via project path with JWT)
    { id: "anthropic/claude-opus-4.8",   name: "Claude Opus 4.8",   projectChat: true },
    { id: "anthropic/claude-opus-4.7",   name: "Claude Opus 4.7",   projectChat: true },
    { id: "anthropic/claude-sonnet-5",   name: "Claude Sonnet 5",   projectChat: true },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", projectChat: true },
    // MiniMax
    { id: "minimax/minimax-m3",   name: "MiniMax M3" },
    { id: "minimax/minimax-m2.7", name: "MiniMax M2.7" },
    { id: "minimax/minimax-m2.5", name: "MiniMax M2.5" },
    // DeepSeek
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    // Alibaba Qwen
    { id: "alibaba/qwen-3.7-plus",        name: "Qwen 3.7 Plus" },
    { id: "alibaba/qwen-3.7-max",         name: "Qwen 3.7 Max Preview" },
    { id: "alibaba/qwen-3.6-plus",        name: "Qwen 3.6 Plus" },
    { id: "alibaba/qwen-3.6-max-preview", name: "Qwen 3.6 Max Preview" },
    // Moonshot Kimi
    { id: "moonshotai/kimi-k3",        name: "Kimi K3" },
    { id: "moonshotai/kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "moonshotai/kimi-k2.6",      name: "Kimi K2.6" },
    { id: "moonshotai/kimi-k2.5",      name: "Kimi K2.5" },
    // Z-AI GLM
    { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    { id: "z-ai/glm-5.1", name: "GLM 5.1" },
    { id: "z-ai/glm-5",   name: "GLM 5" },
    // Google Gemini (project-chat only — 502 on /chat/completions)
    { id: "google/gemini-3.5-flash",              name: "Gemini 3.5 Flash",     projectChat: true },
    { id: "google/gemini-3.1-pro-preview",        name: "Gemini 3.1 Pro Preview", projectChat: true },
    { id: "google/gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite", projectChat: true },
  ],
};
