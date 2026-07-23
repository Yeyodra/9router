import { handleVideoContentProxy } from "@/sse/handlers/videoGeneration.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/videos/{id}/content[?url=...]
 * Proxies video binary with connection Bearer.
 * UniKey: downloads from getunikey.ai/v1/videos/{task_id}/content (not OpenRouter).
 * Optional ?url= is fallback only (often 401 with UniKey key).
 */
export async function GET(request, { params }) {
  const { id } = await params;
  return await handleVideoContentProxy(request, id);
}
