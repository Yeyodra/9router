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
 * GET /v1/videos/{id}/content?url=...
 * Proxies auth-gated video binaries (UniKey/OpenRouter result_url) with connection Bearer.
 * Path {id} is the job id (for logging/sticky); actual file URL is the query param.
 */
export async function GET(request) {
  return await handleVideoContentProxy(request);
}
