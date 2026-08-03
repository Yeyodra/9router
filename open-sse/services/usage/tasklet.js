import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseResetTime } from "./shared.js";

const TASKLET_API = "https://api.tasklet.ai";

export async function getTaskletUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) return { message: "Tasklet session token not available." };

  const organizationId = providerSpecificData?.organizationId;
  if (!organizationId) return { message: "Tasklet connected. No organizationId in credential." };

  try {
    const resp = await proxyAwareFetch(`${TASKLET_API}/api/billing/creditGrants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ organizationId }),
    }, proxyOptions);

    if (resp.status === 401 || resp.status === 403) {
      return { message: "Tasklet session token expired or invalid." };
    }
    if (!resp.ok) {
      return { message: `Tasklet connected. Usage endpoint error (${resp.status})` };
    }

    const data = await resp.json();
    const grants = data.grants || [];
    const totalAvailable = data.totalAvailable || 0;

    if (grants.length === 0) {
      return { message: "Tasklet connected. No credit grants found." };
    }

    const quotas = {};
    for (const grant of grants) {
      const amount = grant.amount || 0;
      const consumed = grant.consumed || 0;
      const remaining = Math.max(0, amount - consumed);
      const type = grant.type || "credits";
      const label = type === "daily_bonus_credits" ? "Daily Bonus" : type.replace(/_/g, " ");

      quotas[label] = {
        used: consumed,
        total: amount,
        remaining,
        remainingPercentage: amount > 0 ? Math.round((remaining / amount) * 100) : 0,
        resetAt: parseResetTime(grant.expiration),
        unlimited: false,
        recurring: type === "daily_bonus_credits",
      };
    }

    return { quotas, totalAvailable };
  } catch (err) {
    return { message: `Tasklet connected. Unable to fetch usage: ${err.message}` };
  }
}
