export default {
  id: "screenpipe",
  priority: 45,
  alias: "sp",
  uiAlias: "sp",
  display: {
    name: "ScreenPipe",
    icon: "screen_share",
    color: "#8B5CF6",
    textIcon: "SP",
    website: "https://screenpipe.com",
    notice: {
      signupUrl: "https://screenpipe.com",
    },
  },
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  transport: {
    baseUrl: "https://api.screenpipe.com/v1/chat/completions",
    format: "openai",
    headers: {
      "User-Agent": "screenpipe-app/2.5.149",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    usage: { url: "https://api.screenpipe.com/v1/usage" },
  },
  models: [
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-5.6", name: "GPT-5.6" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.5-pro", name: "GPT-5.5 Pro" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-pro", name: "GPT-5.4 Pro" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { id: "gpt-5.4-nano", name: "GPT-5.4 Nano" },
    { id: "gpt-5-mini", name: "GPT-5 Mini" },
    { id: "gpt-5-nano", name: "GPT-5 Nano" },
    { id: "auto", name: "Auto (Best)" },
  ],
  oauth: {
    // Clerk-based auth — not standard OAuth2 PKCE/device-code.
    // Token refresh is handled by custom refreshScreenpipeToken in tokenRefresh/providers.js.
    // Credentials stored as providerSpecificData: { email, password, sessionId }.
    refreshLeadMs: 45000, // JWT expires 60s; refresh at 45s
  },
};
