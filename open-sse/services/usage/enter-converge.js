/**
 * Enter Converge / Enter Pro usage handler
 *
 * Credits endpoints (ek_ API key + browser-like headers):
 *   GET /code/api/v1/workspaces/{ws}/credits
 *   GET /code/api/v1/workspaces/{ws}/credits/dashboard
 *   GET /code/api/v1/workspaces/{ws}/subscription/status
 *
 * workspaceId comes from providerSpecificData.workspaceId (required).
 *
 * UI expects:
 *   { plan, quotas: { Name: { used, total, remaining?, remainingPercentage?, resetAt? } } }
 * and ProviderLimitCard shows progress bars only when `message` is absent.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  resolveEnterConvergeWorkspaceId,
  cacheEnterConvergeWorkspaceId,
} from "../../providers/enter-converge-workspace.js";

const BASE = "https://api.enter.pro/code/api/v1";

const BROWSER_HEADERS = {
  Origin: "https://enter.converge.ai",
  Referer: "https://enter.converge.ai/",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function authHeaders(apiKey) {
  return {
    ...BROWSER_HEADERS,
    Authorization: `Bearer ${apiKey}`,
  };
}

async function getJson(url, apiKey, proxyOptions) {
  const res = await proxyAwareFetch(
    url,
    {
      method: "GET",
      headers: authHeaders(apiKey),
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

function quotaRow(remaining, total) {
  const rem = Math.max(0, num(remaining, 0));
  // If we know allotment, show used/total like Kiro/Grok.
  // Else treat remaining as open balance (total=remaining, used=0 → 100% bar).
  if (total != null && Number.isFinite(Number(total)) && Number(total) > 0) {
    const tot = Math.max(rem, num(total, rem));
    const used = Math.max(0, tot - rem);
    const remainingPercentage = tot > 0 ? (rem / tot) * 100 : 100;
    return {
      used,
      total: tot,
      remaining: rem,
      remainingPercentage,
      unlimited: false,
    };
  }
  return {
    used: 0,
    total: rem,
    remaining: rem,
    remainingPercentage: 100,
    unlimited: false,
  };
}

/**
 * Fast path for pool aggregation: 1 request per key (simple credits).
 * Prefer stored workspaceId to skip GET /workspaces.
 * @returns {Promise<{ remaining: number, total: number }|null>}
 */
export async function getEnterConvergeCreditsQuick(apiKey, providerSpecificData = null, proxyOptions = null) {
  if (!apiKey) return null;
  const workspaceId = await resolveEnterConvergeWorkspaceId(
    apiKey,
    providerSpecificData,
    proxyOptions,
  );
  if (!workspaceId) return null;
  cacheEnterConvergeWorkspaceId(apiKey, workspaceId);

  try {
    const simpleUrl = `${BASE}/workspaces/${workspaceId}/credits`;
    const { res, json } = await getJson(simpleUrl, apiKey, proxyOptions);
    if (!res.ok || json?.code !== 0) return null;
    const remaining = num(json?.data?.credits, null);
    if (remaining === null) return null;

    // Soft ceiling for free farm packs (same heuristic as full usage)
    let mainTotal = remaining;
    if (remaining <= 100) mainTotal = 100;
    else if (remaining <= 200) mainTotal = 200;
    else mainTotal = remaining;

    return { remaining, total: mainTotal };
  } catch {
    return null;
  }
}

/**
 * @param {string} apiKey
 * @param {object|null} providerSpecificData  must include workspaceId
 * @param {object|null} proxyOptions
 */
export async function getEnterConvergeUsage(apiKey, providerSpecificData = null, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Enter Converge API key not available." };
  }

  // Auto-resolve from GET /workspaces when farm only stored ek_ (no manual workspace).
  const workspaceId = await resolveEnterConvergeWorkspaceId(
    apiKey,
    providerSpecificData,
    proxyOptions,
  );
  if (!workspaceId) {
    return {
      message:
        "Could not resolve Workspace ID from this API key. Check the key or set Workspace ID manually.",
    };
  }
  cacheEnterConvergeWorkspaceId(apiKey, workspaceId);

  try {
    let remaining = null;
    let bonus = null;
    let daily = null;
    let monthly = null;
    let purchase = null;
    let status = null;
    let plan = "Unknown";
    let dailyCredits = null;

    const dashUrl = `${BASE}/workspaces/${workspaceId}/credits/dashboard`;
    const { res: dashRes, json: dash } = await getJson(dashUrl, apiKey, proxyOptions);

    if (dashRes.status === 401 || dashRes.status === 403) {
      return { message: "Enter Converge API key invalid or blocked (auth)." };
    }

    if (dashRes.ok && dash?.code === 0 && dash?.data) {
      const bal = dash.data.credits_balance || {};
      const br = bal.breakdown || {};
      remaining = num(bal.total, null);
      bonus = num(br.bonus, null);
      daily = num(br.daily, null);
      monthly = num(br.monthly, null);
      purchase = num(br.purchase, null);
      status = bal.status || null;
    } else {
      const simpleUrl = `${BASE}/workspaces/${workspaceId}/credits`;
      const { res: cRes, json: cJson } = await getJson(simpleUrl, apiKey, proxyOptions);
      if (cRes.status === 401 || cRes.status === 403) {
        return { message: "Enter Converge API key invalid or blocked (auth)." };
      }
      if (!cRes.ok || cJson?.code !== 0) {
        return {
          message: `Enter Converge credits API error (${cRes.status})${
            cJson?.message ? `: ${cJson.message}` : ""
          }`,
        };
      }
      remaining = num(cJson?.data?.credits, null);
    }

    // subscription / plan (best-effort) — also grab daily_credits entitlement as allotment hint
    try {
      const subUrl = `${BASE}/workspaces/${workspaceId}/subscription/status`;
      const { res: sRes, json: sJson } = await getJson(subUrl, apiKey, proxyOptions);
      if (sRes.ok && sJson?.code === 0) {
        const st = sJson.data?.status || sJson.data || {};
        const ent = st.entitlement || {};
        plan =
          st.plan_type ||
          ent.plan_type ||
          ent.name ||
          st.subscription?.plan_type ||
          plan;
        if (typeof plan === "string" && plan) {
          plan = plan.charAt(0).toUpperCase() + plan.slice(1);
        }
        if (ent.daily_credits != null) dailyCredits = num(ent.daily_credits, null);
        if (ent.monthly_ai_credits != null && num(ent.monthly_ai_credits) > 0) {
          // keep for potential monthly allotment display later
        }
      }
    } catch {
      // ignore plan errors
    }

    if (remaining === null) {
      return { message: "Enter Converge connected, but credits payload was empty." };
    }

    // Free referral accounts are mostly bonus credits (e.g. 100/200).
    // Prefer bonus bucket as the main bar when it holds almost all remaining.
    const quotas = {};

    // Main "Credits" bar: remaining balance.
    // No true original allotment from API → use remaining as total (full bar = healthy).
    // If bonus == remaining and looks like a common starter pack, use that as total ceiling.
    let mainTotal = remaining;
    if (bonus != null && bonus > 0 && Math.abs(bonus - remaining) < 0.01) {
      // common farm packs: 100 / 200
      if (bonus <= 100) mainTotal = 100;
      else if (bonus <= 200) mainTotal = 200;
      else mainTotal = bonus;
    } else if (dailyCredits != null && dailyCredits > remaining && remaining <= dailyCredits) {
      // fallback: daily entitlement as soft ceiling when balance is small
      mainTotal = Math.max(remaining, dailyCredits);
    }

    // Single bar only — free/farm accounts almost always have remaining == bonus,
    // so Credits + Bonus was visual duplicate noise.
    quotas.Credits = quotaRow(remaining, mainTotal);

    // IMPORTANT: do NOT set `message` when quotas exist —
    // ProviderLimitCard only renders bars when !message.
    return {
      plan: plan || "Unknown",
      quotas,
      // optional debug (ignored by parseQuotaData)
      meta: {
        workspaceId: String(workspaceId),
        credits: remaining,
        status,
        breakdown: { bonus, daily, monthly, purchase },
      },
    };
  } catch (error) {
    return { message: `Enter Converge error: ${error.message}` };
  }
}
