/**
 * Enter Converge workspace helpers.
 *
 * Chat needs X-Workspace-ID. Farm automation only has ek_ keys, so we resolve
 * workspaceId from GET /code/api/v1/workspaces when not stored on the connection.
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";

const WORKSPACES_URL = "https://api.enter.pro/code/api/v1/workspaces";

const BROWSER_HEADERS = {
  Origin: "https://enter.converge.ai",
  Referer: "https://enter.converge.ai/",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

// apiKey -> { workspaceId, expiresAt }
const _cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

export function getStoredWorkspaceId(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const id = psd.workspaceId ?? psd.workspace_id ?? null;
  if (id === null || id === undefined || id === "") return null;
  return String(id);
}

/**
 * Resolve workspace id for an ek_ key.
 * @returns {Promise<string|null>}
 */
export async function resolveEnterConvergeWorkspaceId(apiKey, providerSpecificData = null, proxyOptions = null) {
  const stored = getStoredWorkspaceId({ providerSpecificData });
  if (stored) return stored;
  if (!apiKey) return null;

  const cached = _cache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) return cached.workspaceId;

  try {
    const res = await proxyAwareFetch(
      WORKSPACES_URL,
      {
        method: "GET",
        headers: {
          ...BROWSER_HEADERS,
          Authorization: `Bearer ${apiKey}`,
        },
      },
      proxyOptions,
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const list = json?.data?.workspaces;
    if (!Array.isArray(list) || list.length === 0) return null;
    const ws = list[0]?.id;
    if (ws === null || ws === undefined || ws === "") return null;
    const workspaceId = String(ws);
    _cache.set(apiKey, { workspaceId, expiresAt: Date.now() + CACHE_TTL_MS });
    return workspaceId;
  } catch {
    return null;
  }
}

/** Sync path for header hooks: stored value or warm cache only (no network). */
export function resolveEnterConvergeWorkspaceIdSync(credentials) {
  const stored = getStoredWorkspaceId(credentials);
  if (stored) return stored;
  const apiKey = credentials?.apiKey || credentials?.accessToken;
  if (!apiKey) return null;
  const cached = _cache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) return cached.workspaceId;
  return null;
}

export function cacheEnterConvergeWorkspaceId(apiKey, workspaceId) {
  if (!apiKey || workspaceId == null || workspaceId === "") return;
  _cache.set(apiKey, {
    workspaceId: String(workspaceId),
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}
