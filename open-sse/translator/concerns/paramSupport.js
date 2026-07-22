import { getCapabilitiesForModel } from "../../providers/capabilities.js";

// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.

// Each rule: optional provider, regex match on model, list of params to drop.
// A param is removed only when it is present (!== undefined).
const STRIP_RULES = [
  // All LLM models: temperature deprecated/rejected upstream (provider 400). #1748
  { match: /LLM/i, drop: ["temperature"] },
  // GitHub Copilot model: temperature unsupported.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },
  // GitHub Copilot LLM (except opus/sonnet 4.6): thinking + reasoning_effort rejected. #713
  { provider: "github", match: (m) => /LLM/i.test(m) && !/LLM.*(opus|sonnet).*4\.6/i.test(m), drop: ["thinking", "reasoning_effort"] },
  // Cloudflare Workers AI: content must be plain string, rejects OpenAI content-part array (#1926)
  { provider: "cloudflare-ai", flattenContent: true },
  { provider: "volcengine-ark", match: /glm-5/i, clampToModelMaxOutput: true },
  // VolcEngine Ark caps the Kimi family at max_tokens <= 32768, but the model's
  // advertised ceiling is far higher (Kimi-K2.7-Code resolves to maxOutput 262144),
  // so clampToModelMaxOutput alone leaves it uncapped and the request 400s with
  // "integer above maximum value, expected <= 32768". Pin an explicit endpoint cap;
  // min() with the model ceiling still applies if a variant's own limit is lower.
  { provider: "volcengine-ark", match: /kimi/i, maxOutputCap: 32768, clampToModelMaxOutput: true },
  // Enter Pro: OpenAI models reject max_tokens — must use max_completion_tokens instead.
  // Model ids arrive as "openai/gpt-5.x-*" or bare "gpt-5.x-*".
  { provider: "enter-converge", match: /(^|\/)gpt-/i, renameMaxTokens: true },
  // Enter Pro chat/completions rejects tools + reasoning_effort together for GPT
  // ("Please use /v1/responses instead"). Drop reasoning flags so agent tools work.
  {
    provider: "enter-converge",
    match: /(^|\/)gpt-/i,
    dropReasoningWithTools: true,
    // Also drop reasoning when no tools — THINK:medium still 400s some GPT variants
    // on chat/completions; keep path simple.
    drop: ["reasoning_effort", "thinking", "reasoning"],
  },
  // OpenWebUI/Jan sampling knobs — EC (esp. GPT-5.x) rejects unknown/non-default values.
  {
    provider: "enter-converge",
    drop: [
      "top_k",
      "temperature",
      "top_p",
      "min_p",
      "typical_p",
      "repetition_penalty",
      "frequency_penalty",
      "presence_penalty",
    ],
  },
];

// Test a rule's match (regex or predicate) against the model id.
function matches(rule, model) {
  if (!rule.match) return true;
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

function clampNumber(body, key, ceiling) {
  if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > ceiling) {
    body[key] = ceiling;
  }
}

// Remove unsupported params from body in place; returns body.
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!matches(rule, model)) continue;
    for (const key of rule.drop || []) {
      if (body[key] !== undefined) delete body[key];
    }
    // Enter Pro OpenAI models: rename max_tokens → max_completion_tokens
    if (rule.renameMaxTokens && body.max_tokens !== undefined && body.max_completion_tokens === undefined) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    // Enter Pro: tools + reasoning_effort invalid on /chat/completions for GPT
    if (rule.dropReasoningWithTools) {
      const hasTools =
        (Array.isArray(body.tools) && body.tools.length > 0) ||
        (Array.isArray(body.functions) && body.functions.length > 0);
      if (hasTools || body.reasoning_effort !== undefined || body.thinking !== undefined || body.reasoning !== undefined) {
        delete body.reasoning_effort;
        delete body.thinking;
        delete body.reasoning;
      }
    }
    // CF Workers AI oneOf root schema only accepts content as plain string (#1926)
    if (rule.flattenContent && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg && Array.isArray(msg.content)) {
          msg.content = msg.content
            .map(b => (b?.type === "text" && typeof b.text === "string") ? b.text : "")
            .join("");
        }
      }
    }
    if (rule.clampToModelMaxOutput || Number.isFinite(rule.maxOutputCap)) {
      const modelCeiling = getCapabilitiesForModel(provider, model).maxOutput;
      const candidates = [];
      if (rule.clampToModelMaxOutput && Number.isFinite(modelCeiling) && modelCeiling > 0) {
        candidates.push(modelCeiling);
      }
      if (Number.isFinite(rule.maxOutputCap) && rule.maxOutputCap > 0) {
        candidates.push(rule.maxOutputCap);
      }
      if (candidates.length > 0) {
        const ceiling = Math.min(...candidates);
        clampNumber(body, "max_tokens", ceiling);
        clampNumber(body, "max_completion_tokens", ceiling);
        clampNumber(body, "max_output_tokens", ceiling);
      }
    }
  }
  return body;
}
