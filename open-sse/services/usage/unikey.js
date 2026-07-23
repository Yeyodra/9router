/**
 * UniKey (getunikey.ai) usage — New-API / one-api style.
 *
 * Endpoints (Bearer API key):
 *   GET /v1/dashboard/billing/usage  → { total_usage }  (USD-ish spent)
 *   GET /api/usage/token            → { data: { total_used, total_granted, total_available, unlimited_quota, name } }
 *
 * Note: tokens often have unlimited_quota=true; account gift quota still caps spend.
 * When remaining goes negative, chat returns 用户额度不足 (quota exhausted).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, toFiniteNumber } from "./shared.js";

function num(v, fallback = 0) {
  return toFiniteNumber(v, fallback);
}

async function getJson(url, apiKey, proxyOptions) {
  const res = await proxyAwareFetch(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
    proxyOptions,
  );
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json, text };
}

/**
 * @param {string} apiKey
 * @param {object|null} proxyOptions
 * @returns {Promise<{ plan?: string, quotas?: object, message?: string }>}
 */
export async function getUnikeyUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "UniKey API key not available." };
  }

  const endpoints = U("unikey");
  const billingUrl = endpoints.billing || "https://www.getunikey.ai/v1/dashboard/billing/usage";
  const tokenUrl = endpoints.token || "https://www.getunikey.ai/api/usage/token";

  try {
    const [billing, token] = await Promise.all([
      getJson(billingUrl, apiKey, proxyOptions),
      getJson(tokenUrl, apiKey, proxyOptions),
    ]);

    if (
      (billing.res.status === 401 || billing.res.status === 403) &&
      (token.res.status === 401 || token.res.status === 403)
    ) {
      return { message: "UniKey API key invalid or expired." };
    }

    const quotas = {};
    let plan = "UniKey";
    let exhausted = false;

    // Per-token New-API usage
    if (token.res.ok && token.json) {
      const raw = token.json?.data && typeof token.json.data === "object"
        ? token.json.data
        : token.json;
      const used = num(raw.total_used, 0);
      const granted = num(raw.total_granted, 0);
      const available = num(raw.total_available, 0);
      const unlimited = !!raw.unlimited_quota;
      if (raw.name) plan = String(raw.name);

      if (available < 0) exhausted = true;

      if (unlimited && granted <= 0) {
        // unlimited token, still account-capped — surface used + remaining (clamp)
        const rem = Math.max(0, available);
        quotas["Token units"] = {
          used,
          total: used + rem,
          remaining: rem,
          remainingPercentage: used + rem > 0 ? (rem / (used + rem)) * 100 : (exhausted ? 0 : 100),
          unlimited: !exhausted,
        };
      } else {
        const total = Math.max(granted, used + Math.max(0, available), used);
        const rem = Math.max(0, available);
        quotas["Token units"] = {
          used,
          total,
          remaining: rem,
          remainingPercentage: total > 0 ? (rem / total) * 100 : 0,
          unlimited: false,
        };
      }
    }

    // OpenAI-compat billing (spent so far)
    if (billing.res.ok && billing.json) {
      const spent = num(billing.json.total_usage, 0);
      quotas["Spent (USD)"] = {
        used: spent,
        total: 0,
        remaining: 0,
        remainingPercentage: 100,
        unlimited: true,
      };
    }

    if (!Object.keys(quotas).length) {
      const st = token.res.status || billing.res.status;
      const hint = (token.text || billing.text || "").slice(0, 160);
      return {
        message: `UniKey usage API error (${st})${hint ? `: ${hint}` : ""}`,
      };
    }

    return {
      plan,
      quotas,
      ...(exhausted
        ? { message: "Quota exhausted (remaining ≤ 0). Rotate key or farm a fresh account." }
        : {}),
    };
  } catch (error) {
    return { message: `UniKey usage error: ${error.message}` };
  }
}
