/**
 * Enter Converge "Project Chat" executor path.
 *
 * Models that 502 on /chat/completions (Opus 4.8, Sonnet 5, Gemini, etc.)
 * work via the project-based chat endpoint which uses a different upstream gateway.
 *
 * Flow:
 *   1. POST /workspaces/{ws}/projects  {name, prompt, model}  → project_id
 *   2. Poll GET /projects/{pid}/chats  until Status = "Finished"
 *   3. GET /projects/{pid}/thread/turns → extract assistant content
 *   4. Format as OpenAI-compatible response
 *
 * Requires JWT session token (not ek_ API key). Connection must store
 * accessToken in providerSpecificData or as the primary credential.
 *
 * Model IDs use short format (e.g. "claude-opus-4.8" not "anthropic/claude-opus-4.8").
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";

const BASE = "https://api.enter.pro/code/api/v1";
const AUTH0_TOKEN_URL = "https://auth.converge.ai/oauth/token";
const CLIENT_ID = "anCisSaaIA36fTZ2DUMiTMro3bYuptrf";
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const BROWSER_HEADERS = {
  Origin: "https://enter.converge.ai",
  Referer: "https://enter.converge.ai/",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

// --- JWT Auto-Refresh (every 30 min) ---
// connectionId → { accessToken, refreshToken, lastRefreshAt }
const _tokenCache = new Map();

/**
 * Ensure we have a fresh JWT. Refreshes if last refresh was >30min ago.
 * Mutates credentials.accessToken in-place on success.
 * Also persists updated tokens to 9router DB.
 */
async function ensureFreshJwt(credentials, proxyOptions = null) {
  const connectionId = credentials?.connectionId;
  const refreshToken = credentials?.refreshToken || credentials?.providerSpecificData?.refreshToken;
  if (!refreshToken) return; // no refresh token available, use whatever we have

  const cached = connectionId ? _tokenCache.get(connectionId) : null;
  const now = Date.now();

  // If we refreshed within the interval, use cached token
  if (cached && (now - cached.lastRefreshAt) < REFRESH_INTERVAL_MS) {
    if (cached.accessToken) credentials.accessToken = cached.accessToken;
    return;
  }

  // Do the refresh
  try {
    const body = `grant_type=refresh_token&client_id=${CLIENT_ID}&refresh_token=${encodeURIComponent(refreshToken)}`;
    const res = await proxyAwareFetch(
      AUTH0_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Origin: "https://enter.converge.ai",
        },
        body,
      },
      proxyOptions,
    );

    if (!res.ok) {
      dbg("enter-jwt-refresh", `refresh failed: ${res.status}`);
      return;
    }

    const data = await res.json().catch(() => null);
    if (!data?.access_token) return;

    dbg("enter-jwt-refresh", `refreshed OK (expires_in=${data.expires_in})`);

    // Update credentials in-place
    credentials.accessToken = data.access_token;
    if (data.refresh_token) {
      credentials.refreshToken = data.refresh_token;
    }

    // Cache
    if (connectionId) {
      _tokenCache.set(connectionId, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        lastRefreshAt: now,
      });
    }

    // Persist to 9router DB (fire-and-forget)
    persistTokensToDb(connectionId, data.access_token, data.refresh_token || refreshToken).catch(() => {});
  } catch (e) {
    dbg("enter-jwt-refresh", `refresh error: ${e.message}`);
  }
}

/**
 * Persist refreshed tokens back to 9router SQLite DB.
 */
async function persistTokensToDb(connectionId, accessToken, refreshToken) {
  if (!connectionId) return;
  try {
    // Dynamic import to avoid hard dep on better-sqlite3 (may not be available in all envs)
    const { default: Database } = await import("better-sqlite3");
    const path = await import("path");
    const os = await import("os");

    const appData = process.env.APPDATA || path.join(os.homedir(), ".config");
    const dbPath = path.join(appData, "9router", "db", "data.sqlite");

    const db = new Database(dbPath);
    const row = db.prepare("SELECT data FROM providerConnections WHERE id = ?").get(connectionId);
    if (row) {
      const data = JSON.parse(row.data || "{}");
      data.accessToken = accessToken;
      if (refreshToken) data.refreshToken = refreshToken;
      const now = new Date().toISOString();
      db.prepare("UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?")
        .run(JSON.stringify(data), now, connectionId);
    }
    db.close();
  } catch {
    // silently fail — DB persistence is best-effort
  }
}

// vendor/slug → short name for project chat
function toShortModel(modelId) {
  // "anthropic/claude-opus-4.8" → "claude-opus-4.8"
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

// Last user message from messages array
function extractPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "hi";
  // Find last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      // Array content (multimodal) — extract text parts
      if (Array.isArray(content)) {
        return content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n") || "hi";
      }
    }
  }
  return "hi";
}

// Build system prompt if present
function extractSystemPrompt(messages) {
  if (!Array.isArray(messages)) return null;
  const sys = messages.filter((m) => m.role === "system");
  if (sys.length === 0) return null;
  return sys.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

async function apiFetch(path, token, ws, options = {}, proxyOptions = null) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const headers = {
    ...BROWSER_HEADERS,
    Authorization: `Bearer ${token}`,
    "X-Workspace-ID": ws,
    ...options.headers,
  };
  if (options.body) headers["Content-Type"] = "application/json";

  const res = await proxyAwareFetch(
    url,
    {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    proxyOptions,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text };
  }
  const json = await res.json().catch(() => null);
  return { ok: true, status: res.status, data: json };
}

/**
 * Execute a chat via Enter Converge project-chat path.
 *
 * @param {object} params
 * @param {string} params.model - Full model id (e.g. "anthropic/claude-opus-4.8")
 * @param {object} params.body - OpenAI-format request body (messages, max_tokens, etc.)
 * @param {object} params.credentials - { apiKey, accessToken, providerSpecificData }
 * @param {object|null} params.proxyOptions
 * @param {function|null} params.log
 * @returns {Promise<{response: Response}|{error: object}>}
 */
export async function executeProjectChat({ model, body, credentials, proxyOptions = null, log = null }) {
  // Auto-refresh JWT every 30 minutes
  await ensureFreshJwt(credentials, proxyOptions);

  // Project chat requires JWT (Auth0 access_token), not ek_ API key.
  // Prefer accessToken (JWT); fall back to apiKey only if it looks like a JWT (starts with eyJ).
  const rawToken = credentials?.accessToken || credentials?.apiKey;
  const isJwt = rawToken?.startsWith?.("eyJ");
  const token = isJwt ? rawToken : null;
  const ws = credentials?.providerSpecificData?.workspaceId;

  if (!token || !ws) {
    return {
      error: {
        status: 401,
        message: token
          ? "Project chat requires workspaceId in providerSpecificData"
          : "Project chat requires JWT session token (not ek_ API key). Add accessToken to connection or use a JWT-bearing connection.",
      },
    };
  }

  const shortModel = toShortModel(model);
  const prompt = extractPrompt(body?.messages);
  const systemPrompt = extractSystemPrompt(body?.messages);
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

  dbg("enter-project-chat", `model=${shortModel} prompt=${fullPrompt.slice(0, 60)}...`);

  // Step 1: Create project
  const createRes = await apiFetch(
    `/workspaces/${ws}/projects`,
    token,
    ws,
    {
      method: "POST",
      body: { name: `chat-${Date.now()}`, prompt: fullPrompt, model: shortModel },
    },
    proxyOptions,
  );

  if (!createRes.ok) {
    log?.warn?.("ENTER-PROJECT", `create failed: ${createRes.status} ${createRes.error?.slice?.(0, 100)}`);
    return { error: { status: createRes.status, message: createRes.error || "project create failed" } };
  }

  const projectId = createRes.data?.data?.project?.project_id;
  if (!projectId) {
    return { error: { status: 500, message: "no project_id in create response" } };
  }

  dbg("enter-project-chat", `created project=${projectId}`);

  // Step 2: Poll until Finished (max ~60s)
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLLS = 30;
  let chatStatus = "Running";
  let chatName = "";

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const pollRes = await apiFetch(`/projects/${projectId}/chats`, token, ws, {}, proxyOptions);
    if (!pollRes.ok) continue;

    const chat = pollRes.data?.data?.chats?.[0]?.chat;
    if (!chat) continue;

    chatStatus = chat.Status || chat.status || "Running";
    chatName = chat.Name || chat.name || "";

    if (chatStatus === "Finished") {
      dbg("enter-project-chat", `finished in ${(i + 1) * 2}s name="${chatName}"`);
      break;
    }
    if (chatStatus === "Failed") {
      return { error: { status: 502, message: `project chat failed: ${chatName}` } };
    }
  }

  if (chatStatus !== "Finished") {
    return { error: { status: 504, message: "project chat timeout (60s)" } };
  }

  // Step 3: Get response content
  // Turns don't contain message text — content is stored as project files (git commits).
  // Try: /projects/{pid}/files then read the main file content.
  const turnsRes = await apiFetch(`/projects/${projectId}/thread/turns`, token, ws, {}, proxyOptions);
  let assistantContent = chatName; // fallback to auto-title

  const turns = turnsRes.ok ? (turnsRes.data?.data?.turns || []) : [];
  const turn = turns[0];

  // Try fetching project files (response written as file)
  const filesRes = await apiFetch(`/projects/${projectId}/files`, token, ws, {}, proxyOptions);
  dbg("enter-project-chat", `files ok=${filesRes.ok} data=${JSON.stringify(filesRes.data).slice(0, 500)}`);

  if (filesRes.ok && filesRes.data?.data) {
    const files = filesRes.data.data.files || filesRes.data.data || [];
    // Try reading first non-empty file
    if (Array.isArray(files) && files.length > 0) {
      for (const f of files) {
        const filePath = f.path || f.name || f.file_path || "";
        if (!filePath) continue;
        const fileRes = await apiFetch(`/projects/${projectId}/files/${encodeURIComponent(filePath)}`, token, ws, {}, proxyOptions);
        dbg("enter-project-chat", `file "${filePath}" ok=${fileRes.ok} data=${JSON.stringify(fileRes.data).slice(0, 300)}`);
        const content = fileRes.data?.data?.content || fileRes.data?.content || "";
        if (content) {
          assistantContent = content;
          break;
        }
      }
    }
  }

  // Fallback: try thread/turns/{id} (single turn detail) or stream replay
  if (assistantContent === chatName && turn?.id) {
    const turnDetailRes = await apiFetch(`/projects/${projectId}/thread/turns/${turn.id}`, token, ws, {}, proxyOptions);
    dbg("enter-project-chat", `turn detail ok=${turnDetailRes.ok} data=${JSON.stringify(turnDetailRes.data).slice(0, 500)}`);
    const detail = turnDetailRes.data?.data;
    if (detail) {
      const content = detail.content || detail.text || detail.message || detail.output || "";
      if (content) assistantContent = typeof content === "string" ? content : JSON.stringify(content);
    }
  }

  // Step 4: Format as OpenAI-compatible response
  const completionId = `chatcmpl-ec-${projectId}`;
  const created = Math.floor(Date.now() / 1000);
  const isStream = body?.stream === true;

  if (isStream) {
    // SSE format: single delta chunk + [DONE]
    const chunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: assistantContent }, finish_reason: null }],
    };
    const doneChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    const sseBody = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`;
    const syntheticResponse = new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
    return { response: syntheticResponse };
  }

  // Non-streaming: plain JSON
  const responseBody = {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: assistantContent },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  const syntheticResponse = new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  return { response: syntheticResponse };
}

/**
 * Check if a model requires project-chat path.
 * @param {string} provider
 * @param {string} modelId
 * @param {Array} modelsList - provider's models array from registry
 */
export function isProjectChatModel(provider, modelId, modelsList) {
  if (provider !== "enter-converge") return false;
  if (!modelsList) return false;
  const entry = modelsList.find((m) => m.id === modelId);
  return entry?.projectChat === true;
}
