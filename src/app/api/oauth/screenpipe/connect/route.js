import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

const CLERK_BASE = "https://clerk.screenpipe.com";
const CLERK_JS = "5.56.0";
const ORIGIN = "https://screenpipe.com";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export async function POST(request) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }

    const clerkHeaders = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      "User-Agent": BROWSER_UA,
    };

    // Clerk requires __client cookie from /v1/client init before sign-in works
    const clientInitRes = await fetch(
      `${CLERK_BASE}/v1/client?_clerk_js_version=${CLERK_JS}`,
      { method: "GET", headers: { Accept: "application/json", Origin: ORIGIN, Referer: `${ORIGIN}/`, "User-Agent": BROWSER_UA } }
    );
    const setCookies = clientInitRes.headers.getSetCookie?.() || [];
    const clientCookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    const authedHeaders = { ...clerkHeaders, ...(clientCookie ? { Cookie: clientCookie } : {}) };

    const signInRes = await fetch(
      `${CLERK_BASE}/v1/client/sign_ins?_clerk_js_version=${CLERK_JS}`,
      {
        method: "POST",
        headers: authedHeaders,
        body: new URLSearchParams({ identifier: email, strategy: "password", password }),
      }
    );

    if (!signInRes.ok) {
      const errText = await signInRes.text().catch(() => "");
      return NextResponse.json(
        { error: `Sign-in failed (${signInRes.status}): ${errText.slice(0, 200)}` },
        { status: 401 }
      );
    }

    const signInData = await signInRes.json();
    const sessionId =
      signInData?.response?.created_session_id ||
      signInData?.client?.sessions?.[0]?.id ||
      "";

    if (!sessionId) {
      return NextResponse.json({ error: "No session returned from Clerk sign-in" }, { status: 500 });
    }

    const signInCookies = signInRes.headers.getSetCookie?.() || [];
    const tokenCookie = signInCookies.length ? signInCookies.map((c) => c.split(";")[0]).join("; ") : clientCookie;
    const tokenHeaders = { ...clerkHeaders, ...(tokenCookie ? { Cookie: tokenCookie } : {}) };

    const tokenRes = await fetch(
      `${CLERK_BASE}/v1/client/sessions/${sessionId}/tokens?_clerk_js_version=${CLERK_JS}`,
      {
        method: "POST",
        headers: tokenHeaders,
        body: "",
      }
    );

    if (!tokenRes.ok) {
      return NextResponse.json({ error: "Failed to mint JWT from session" }, { status: 500 });
    }

    const tokenData = await tokenRes.json();
    const jwt = tokenData?.jwt;

    if (!jwt) {
      return NextResponse.json({ error: "Empty JWT in token response" }, { status: 500 });
    }

    const connection = await createProviderConnection({
      provider: "screenpipe",
      authType: "oauth",
      name: email,
      email,
      accessToken: jwt,
      refreshToken: sessionId,
      providerSpecificData: { email, password, sessionId },
      testStatus: "active",
      isActive: true,
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: "screenpipe",
        email,
      },
    });
  } catch (error) {
    console.error("ScreenPipe connect error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
