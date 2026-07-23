import { cookies } from "next/headers";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { getSettings, getApiKeys } from "@/lib/localDb";
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

export const dynamic = "force-dynamic";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Playground chat: session-cookie auth, reuses handleChat.
 * When requireApiKey is on, attaches first active API key server-side
 * so the browser never sees it.
 */
export async function POST(request) {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const ok = await verifyDashboardAuthToken(token);
  if (!ok) {
    return jsonError(401, "Unauthorized");
  }

  await ensureInitialized();

  const bodyText = await request.text();
  const headers = new Headers(request.headers);
  headers.set("x-9r-playground", "1");
  // Cookie auth already proved identity; strip any client Authorization
  // so requireApiKey path only uses server-attached keys.
  headers.delete("authorization");

  const settings = await getSettings();
  if (settings.requireApiKey) {
    const keys = await getApiKeys();
    const active = keys.find((k) => k.isActive && k.key);
    if (!active) {
      return jsonError(
        400,
        "No active API key. Create one on the Endpoint page."
      );
    }
    headers.set("Authorization", `Bearer ${active.key}`);
  }

  const chatRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: bodyText,
  });

  return handleChat(chatRequest);
}
