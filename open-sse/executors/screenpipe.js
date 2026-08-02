import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { refreshScreenpipeToken } from "../services/tokenRefresh/providers.js";

export class ScreenPipeExecutor extends BaseExecutor {
  constructor() {
    super("screenpipe", PROVIDERS.screenpipe);
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "screenpipe-app/2.5.149",
    };

    const token = credentials.accessToken || credentials.apiKey;
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  buildUrl() {
    return "https://api.screenpipe.com/v1/chat/completions";
  }

  needsRefresh(credentials) {
    return true;
  }

  async refreshCredentials(credentials, log) {
    const result = await refreshScreenpipeToken(
      credentials.refreshToken,
      credentials.providerSpecificData,
      log,
    );
    if (!result || result.error) return null;
    return result;
  }
}

export default ScreenPipeExecutor;
