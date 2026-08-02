import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const TASKLET_API = "https://api.tasklet.ai";
const TASKLET_WS = "wss://api.tasklet.ai/api/sync";

function toUpstreamModelId(modelId) {
  return modelId.replace(/[.\-]/g, "_");
}

function buildTaskletMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  if (messages.length === 1 && messages[0].role === "user") return extractContent(messages[0]);

  const parts = [];
  for (const msg of messages) {
    const role = msg.role || "user";
    const content = extractContent(msg);

    if (role === "system" || role === "developer") {
      if (content.trim()) parts.push(`[System]: ${content}`);
    } else if (role === "assistant") {
      if (content.trim()) parts.push(`[Assistant]: ${content}`);
      if (msg.tool_calls?.length) {
        const calls = msg.tool_calls.map((tc) => `[Tool Call: ${tc.function?.name || "unknown"}]`).join("\n");
        parts.push(calls);
      }
    } else if (role === "tool") {
      const name = msg.name || msg.tool_call_id || "tool";
      const truncated = content.length > 3000 ? content.slice(0, 3000) + "...(truncated)" : content;
      parts.push(`[Tool Result (${name})]: ${truncated}`);
    } else {
      if (content.trim()) parts.push(content);
    }
  }
  return parts.join("\n\n");
}

function extractContent(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join(" ");
  }
  return "";
}

function collectWsResponse(sessionToken, agentId, signal, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let content = "";
    let thinking = "";
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        ws.close();
        resolve({ content: content || "[Tasklet timeout]", thinking });
      }
    }, timeoutMs);

    const ws = new WebSocket(TASKLET_WS);

    if (signal) {
      signal.addEventListener("abort", () => {
        if (!done) { done = true; clearTimeout(timeout); ws.close(); reject(new Error("Aborted")); }
      });
    }

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "connect", sessionToken }));
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());

        if (msg.type === "connected") {
          ws.send(JSON.stringify({ type: "startSync", agentId }));
          ws.send(JSON.stringify({ type: "subscribeBlocks", runId: agentId, pageSize: 50 }));
          return;
        }

        if (msg.type === "error") {
          if (!done) { done = true; clearTimeout(timeout); ws.close(); reject(new Error(msg.error || "Tasklet WS error")); }
          return;
        }

        if (msg.type === "blocksUpdate" && msg.updates) {
          for (const block of Object.values(msg.updates)) {
            if (block.type === "agent_content" && block.content) content = block.content;
            if (block.type === "thinking" && block.content) thinking = block.content;
          }
        }

        if (msg.type === "syncUpdate" && msg.state?.runState?.type === "idle") {
          if (!done) {
            done = true; clearTimeout(timeout); ws.close();
            if (!content) reject(new Error("QUOTA_EXHAUSTED"));
            else resolve({ content, thinking });
          }
        }
      } catch { /* ignore */ }
    });

    ws.addEventListener("error", (err) => {
      if (!done) { done = true; clearTimeout(timeout); reject(err); }
    });

    ws.addEventListener("close", () => {
      if (!done) { done = true; clearTimeout(timeout); resolve({ content, thinking }); }
    });
  });
}

async function* streamWsTokens(sessionToken, agentId, signal, timeoutMs = 120000) {
  const ws = new WebSocket(TASKLET_WS);

  let done = false;
  const queue = [];
  let resolver = null;
  let error = null;
  let lastContent = "";
  let lastThinking = "";

  const cleanup = () => { clearTimeout(timeout); clearInterval(kaInterval); };

  const timeout = setTimeout(() => {
    if (!done) { done = true; cleanup(); ws.close(); enqueue(null); }
  }, timeoutMs);

  const kaInterval = setInterval(() => {
    if (!done) enqueue({ keepalive: true });
  }, 15000);

  if (signal) {
    signal.addEventListener("abort", () => {
      if (!done) { done = true; cleanup(); ws.close(); enqueue(null); }
    });
  }

  function enqueue(item) {
    if (resolver) { const r = resolver; resolver = null; r(item); }
    else queue.push(item);
  }

  function next() {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    if (done) return Promise.resolve(null);
    return new Promise((r) => { resolver = r; });
  }

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "connect", sessionToken }));
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());

      if (msg.type === "connected") {
        ws.send(JSON.stringify({ type: "startSync", agentId }));
        ws.send(JSON.stringify({ type: "subscribeBlocks", runId: agentId, pageSize: 50 }));
        return;
      }

      if (msg.type === "error") {
        done = true; cleanup(); error = msg.error || "Tasklet WS error"; ws.close(); enqueue(null);
        return;
      }

      if (msg.type === "blocksUpdate" && msg.updates) {
        for (const block of Object.values(msg.updates)) {
          if (block.type === "agent_content" && typeof block.content === "string") {
            const delta = block.content.slice(lastContent.length);
            lastContent = block.content;
            if (delta) enqueue({ delta });
          }
          if (block.type === "thinking" && typeof block.content === "string") {
            const delta = block.content.slice(lastThinking.length);
            lastThinking = block.content;
            if (delta) enqueue({ thinking: delta });
          }
        }
      }

      if (msg.type === "syncUpdate") {
        if (msg.state?.runState?.type === "idle") {
          done = true; cleanup(); ws.close();
          if (!lastContent) { error = "QUOTA_EXHAUSTED"; }
          enqueue(null);
        } else {
          enqueue({ keepalive: true });
        }
      }
    } catch { /* ignore */ }
  });

  ws.addEventListener("error", (err) => {
    if (!done) { done = true; cleanup(); error = err.message || "WebSocket error"; enqueue(null); }
  });

  ws.addEventListener("close", () => {
    if (!done) { done = true; cleanup(); enqueue(null); }
  });

  while (true) {
    const item = await next();
    if (item === null) break;
    yield item;
  }
  if (error) yield { error };
}

export class TaskletExecutor extends BaseExecutor {
  constructor() {
    super("tasklet", PROVIDERS.tasklet);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Missing or empty messages array", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: TASKLET_API, headers: {}, transformedBody: body };
    }

    const sessionToken = credentials.apiKey || credentials.accessToken || "";
    if (!sessionToken) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Tasklet requires a sessionToken as API key", type: "auth_error" },
      }), { status: 401, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: TASKLET_API, headers: {}, transformedBody: body };
    }

    const upstreamModel = toUpstreamModelId(model);
    const message = buildTaskletMessage(messages);

    if (!message.trim()) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Empty message after processing", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: TASKLET_API, headers: {}, transformedBody: body };
    }

    // Derive workspaceId and organizationId from credential metadata if available
    const workspaceId = credentials.providerSpecificData?.workspaceId || "";
    const organizationId = credentials.providerSpecificData?.organizationId || "";

    const taskletPayload = {
      agentId: "new",
      message,
      timezone: "America/Los_Angeles",
      fileIds: [],
      intelligence: "advanced",
      modelConfig: {
        model: upstreamModel,
        thinkingEffort: "low",
        chatHistory: "default",
        serviceTier: "standard",
        preset: "basic",
      },
      agentConfig: { preview: true },
      workspaceId,
    };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    };

    log?.info?.("TASKLET", `Sending to ${upstreamModel}, msg_len=${message.length}`);

    // Step 1: POST sendChatMessage to get agentId
    let agentId;
    try {
      const resp = await proxyAwareFetch(`${TASKLET_API}/api/sendChatMessage`, {
        method: "POST",
        headers,
        body: JSON.stringify(taskletPayload),
        signal,
      }, proxyOptions);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
        log?.warn?.("TASKLET", `sendChatMessage failed: ${resp.status} — ${errText}`);
        const errResp = new Response(JSON.stringify({
          error: { message: `Tasklet API error: ${errText}`, type: "upstream_error", code: `HTTP_${resp.status}` },
        }), { status: resp.status, headers: { "Content-Type": "application/json" } });
        return { response: errResp, url: `${TASKLET_API}/api/sendChatMessage`, headers, transformedBody: taskletPayload };
      }

      const data = await resp.json();
      agentId = data.agentId;
      if (!agentId) {
        const errResp = new Response(JSON.stringify({
          error: { message: "Tasklet returned no agentId", type: "upstream_error" },
        }), { status: 502, headers: { "Content-Type": "application/json" } });
        return { response: errResp, url: `${TASKLET_API}/api/sendChatMessage`, headers, transformedBody: taskletPayload };
      }
    } catch (err) {
      if (err.name === "AbortError") throw err;
      log?.error?.("TASKLET", `sendChatMessage fetch failed: ${err.message}`);
      const errResp = new Response(JSON.stringify({
        error: { message: `Tasklet connection failed: ${err.message}`, type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: `${TASKLET_API}/api/sendChatMessage`, headers, transformedBody: taskletPayload };
    }

    log?.info?.("TASKLET", `Got agentId=${agentId}, connecting WS for response`);

    // Step 2: Connect WS and collect/stream response
    const cid = `chatcmpl-tasklet-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      const encoder = new TextEncoder();
      const sseStream = new ReadableStream({
        async start(controller) {
          try {
            // Initial role chunk
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            })));

            for await (const chunk of streamWsTokens(sessionToken, agentId, signal)) {
              if (chunk.keepalive) {
                controller.enqueue(encoder.encode(": ka\n\n"));
                continue;
              }
              if (chunk.error) {
                controller.enqueue(encoder.encode(sseChunk({
                  id: cid, object: "chat.completion.chunk", created, model,
                  choices: [{ index: 0, delta: { content: `[Error: ${chunk.error}]` }, finish_reason: null }],
                })));
                break;
              }
              if (chunk.thinking) {
                controller.enqueue(encoder.encode(sseChunk({
                  id: cid, object: "chat.completion.chunk", created, model,
                  choices: [{ index: 0, delta: { reasoning_content: chunk.thinking }, finish_reason: null }],
                })));
              }
              if (chunk.delta) {
                controller.enqueue(encoder.encode(sseChunk({
                  id: cid, object: "chat.completion.chunk", created, model,
                  choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }],
                })));
              }
            }

            // Final stop chunk
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })));
            controller.enqueue(encoder.encode(SSE_DONE));
          } catch (err) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { content: `[Stream error: ${err.message}]` }, finish_reason: "stop" }],
            })));
            controller.enqueue(encoder.encode(SSE_DONE));
          } finally {
            controller.close();
          }
        },
      });

      const finalResponse = new Response(sseStream, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } });
      return { response: finalResponse, url: `${TASKLET_API}/api/sendChatMessage`, headers, transformedBody: taskletPayload };
    }

    try {
      const result = await collectWsResponse(sessionToken, agentId, signal);
      const promptTokens = Math.ceil(message.length / 4);
      const completionTokens = Math.ceil(result.content.length / 4);

      const msg = { role: "assistant", content: result.content };
      if (result.thinking) msg.reasoning_content = result.thinking;

      const finalResponse = new Response(JSON.stringify({
        id: cid, object: "chat.completion", created, model,
        choices: [{ index: 0, message: msg, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      return { response: finalResponse, url: `${TASKLET_API}/api/sendChatMessage`, headers, transformedBody: taskletPayload };
    } catch (err) {
      if (err.name === "AbortError") throw err;
      if (err.message === "QUOTA_EXHAUSTED") {
        log?.warn?.("TASKLET", `Account quota exhausted — no content produced`);
        const errResp = new Response(JSON.stringify({
          error: { message: "Tasklet account quota exhausted", type: "insufficient_quota", code: "insufficient_quota" },
        }), { status: 429, headers: { "Content-Type": "application/json" } });
        return { response: errResp, url: `${TASKLET_API}/api/sendChatMessage`, headers, transformedBody: taskletPayload };
      }
      log?.error?.("TASKLET", `WS response failed: ${err.message}`);
      const errResp = new Response(JSON.stringify({
        error: { message: `Tasklet WS error: ${err.message}`, type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: `${TASKLET_API}/api/sendChatMessage`, headers, transformedBody: taskletPayload };
    }
  }
}

export default TaskletExecutor;
