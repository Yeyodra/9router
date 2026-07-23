// OpenAI-compatible adapter (used by openai, minimax, openrouter, recraft)
import { PROVIDER_MEDIA } from "../../providers/index.js";

const imageCfg = (id) => PROVIDER_MEDIA[id]?.imageConfig || {};
const imageUrl = (id) => imageCfg(id).baseUrl;

export default function createOpenAIAdapter(providerId) {
  const cfg = imageCfg(providerId);
  return {
    buildUrl: () => imageUrl(providerId),
    buildHeaders: (creds) => {
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      const key = creds?.apiKey || creds?.accessToken;
      if (key) headers["Authorization"] = `Bearer ${key}`;
      return headers;
    },
    buildBody: (model, body) => {
      const { prompt, n = 1, size, quality, style, response_format } = body;
      const full = { model, prompt, n };
      // UI default "auto" is not a real size. UniKey/Gemini maps it to aspect_ratio "auto" → 400.
      // Empty/auto → omit size (upstream picks default) unless bodyFields requires it.
      if (size && size !== "auto") full.size = size;
      else if (!size) full.size = "1024x1024"; // classic OpenAI callers that omit size
      // "auto" quality/background are placeholders — only forward concrete values
      if (quality && quality !== "auto") full.quality = quality;
      if (style) full.style = style;
      if (response_format) full.response_format = response_format;
      // bodyFields whitelist (e.g. xAI accepts only model/prompt/n/response_format)
      if (Array.isArray(cfg.bodyFields)) {
        const req = {};
        for (const f of cfg.bodyFields) if (full[f] !== undefined) req[f] = full[f];
        return req;
      }
      return full;
    },
    normalize: (responseBody) => responseBody,
  };
}
