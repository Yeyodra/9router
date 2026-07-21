/**
 * GET /api/usage/enter-converge/pool
 *
 * Aggregate remaining credits across ALL enter-converge connections.
 * One server round-trip for the UI (instead of N browser → /api/usage calls).
 *
 * Uses the lightweight credits endpoint only (no dashboard/subscription).
 * In-memory cache ~45s.
 */

import "open-sse/index.js";

import { getProviderConnections } from "@/lib/localDb";
import { getEnterConvergeCreditsQuick } from "open-sse/services/usage/enter-converge.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_TTL_MS = 45_000;
const CONCURRENCY = 24;

let _cache = null; // { expiresAt, payload }

function emptyPayload(extra = {}) {
  return {
    accounts: 0,
    withData: 0,
    failed: 0,
    remaining: 0,
    total: 0,
    pct: 0,
    loading: false,
    cached: false,
    ...extra,
  };
}

async function mapPool(items, concurrency, fn) {
  let idx = 0;
  const results = new Array(items.length);
  async function worker() {
    while (idx < items.length) {
      const i = idx;
      idx += 1;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export async function GET() {
  try {
    const now = Date.now();
    if (_cache && _cache.expiresAt > now) {
      return Response.json({ ..._cache.payload, cached: true, loading: false });
    }

    const all = await getProviderConnections();
    const ec = (all || []).filter(
      (c) => c.provider === "enter-converge" && c.isActive !== false,
    );

    if (ec.length === 0) {
      const payload = emptyPayload();
      _cache = { expiresAt: now + CACHE_TTL_MS, payload };
      return Response.json(payload);
    }

    let remaining = 0;
    let total = 0;
    let withData = 0;
    let failed = 0;

    await mapPool(ec, CONCURRENCY, async (conn) => {
      try {
        const proxyOptions = await resolveConnectionProxyConfig(
          conn.providerSpecificData || {},
        ).catch(() => null);
        const row = await getEnterConvergeCreditsQuick(
          conn.apiKey,
          conn.providerSpecificData || {},
          proxyOptions,
        );
        if (!row || !Number.isFinite(row.remaining)) {
          failed += 1;
          return;
        }
        remaining += row.remaining;
        total += Number.isFinite(row.total) && row.total > 0 ? row.total : row.remaining;
        withData += 1;
      } catch {
        failed += 1;
      }
    });

    const tot = total > 0 ? total : remaining;
    const pct = tot > 0 ? Math.round((remaining / tot) * 100) : remaining > 0 ? 100 : 0;
    const payload = {
      accounts: ec.length,
      withData,
      failed,
      remaining,
      total: tot,
      pct,
      loading: false,
      cached: false,
    };
    _cache = { expiresAt: Date.now() + CACHE_TTL_MS, payload };
    return Response.json(payload);
  } catch (e) {
    console.error("[enter-converge pool]", e);
    return Response.json(
      { error: e?.message || "pool failed", ...emptyPayload({ loading: false }) },
      { status: 500 },
    );
  }
}
