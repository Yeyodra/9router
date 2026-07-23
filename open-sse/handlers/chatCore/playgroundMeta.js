/**
 * Playground routing-meta surface (T3).
 *
 * Gated by request header `x-9r-playground: 1` (set by dashboard chat route).
 * External /v1 clients never set it → no extra SSE events / headers.
 *
 * Delivery:
 * - Stream: one early + one final SSE `data:` line with object "9router.meta"
 *   (OpenAI clients ignore unknown object types; no choices/delta).
 * - Non-stream: response headers x-9r-provider / x-9r-model / x-9r-connection-id;
 *   usage already on OpenAI-style JSON body.usage.
 * - Stream responses also set the same routing headers (available as soon as headers land).
 *
 * Never put secrets (tokens, API keys) in meta.
 */

export const PLAYGROUND_FLAG_HEADER = "x-9r-playground";

function headerGet(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(name.toLowerCase());
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** @param {object|null|undefined} clientRawRequest */
export function isPlaygroundRequest(clientRawRequest) {
  const v = headerGet(clientRawRequest?.headers, PLAYGROUND_FLAG_HEADER);
  return v === "1" || v === 1 || String(v || "").toLowerCase() === "true";
}

/**
 * @param {{ provider: string, model: string, connectionId?: string|null, usage?: object|null }} opts
 * @returns {{ object: string, provider: string, model: string, connectionId?: string, usage?: object }}
 */
export function buildPlaygroundMeta({ provider, model, connectionId, usage }) {
  const meta = {
    object: "9router.meta",
    provider: provider || "unknown",
    model: model || "unknown",
  };
  if (connectionId) meta.connectionId = connectionId;

  if (usage && typeof usage === "object") {
    const prompt = usage.prompt_tokens ?? usage.input_tokens;
    const completion = usage.completion_tokens ?? usage.output_tokens;
    const total =
      usage.total_tokens ??
      (prompt != null || completion != null
        ? (Number(prompt) || 0) + (Number(completion) || 0)
        : undefined);
    const u = {};
    if (prompt != null) u.prompt_tokens = Number(prompt) || 0;
    if (completion != null) u.completion_tokens = Number(completion) || 0;
    if (total != null) u.total_tokens = Number(total) || 0;
    if (Object.keys(u).length) meta.usage = u;
  }
  return meta;
}

/** Routing headers (safe, no secrets). */
export function playgroundRoutingHeaders({ provider, model, connectionId }) {
  const h = {
    "x-9r-provider": String(provider || ""),
    "x-9r-model": String(model || ""),
  };
  if (connectionId) h["x-9r-connection-id"] = String(connectionId);
  return h;
}

export function formatPlaygroundMetaSSE(meta) {
  return `data: ${JSON.stringify(meta)}\n\n`;
}
