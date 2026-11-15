import { NextRequest, NextResponse } from "next/server";
import { orgsEnabled } from "../../../../lib/features";

export const dynamic = "force-dynamic";

const COOKIE = "aimo_session";
const ALLOWED_ROOTS = new Set(["auth", "me", "organizations", "invitations"]);

/**
 * Backend-for-frontend for the organizations workspace. The browser never holds the session
 * token: it lives in an httpOnly cookie on this origin and is attached as a bearer token here,
 * server-side. This route adds no authority of its own — aimo-api authenticates the session and
 * authorizes every request; this only moves the credential out of reach of page scripts.
 *
 * It deliberately cannot reach the demo's X-API-Key routes (quotes, orders): only the platform
 * path roots above are forwarded, and the demo API key is never sent from here.
 */
async function handle(req: NextRequest, { params }: { params: { path: string[] } }) {
  if (!orgsEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const segments = params.path ?? [];
  if (!ALLOWED_ROOTS.has(segments[0]) || segments.some((s) => s === "." || s === "..")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Cookie-authenticated writes must come from this origin (the cookie is also SameSite=Lax).
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (!origin || !host || new URL(origin).host !== host) {
      return NextResponse.json({ error: "forbidden", message: "Cross-origin request refused." }, { status: 403 });
    }
  }

  const base = process.env.AIMO_API_BASE_URL ?? "http://localhost:8080";
  const path = segments.map(encodeURIComponent).join("/");
  const token = req.cookies.get(COOKIE)?.value;
  const body = req.method === "GET" ? undefined : await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/${path}${req.nextUrl.search}`, {
      method: req.method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body || undefined,
      cache: "no-store"
    });
  } catch {
    return NextResponse.json({ error: "api_unreachable", message: "The AIMO BRAIN API could not be reached." }, { status: 502 });
  }

  const text = await upstream.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: "bad_upstream_response" };
  }

  const isSessionStart = path === "auth/login" || path === "auth/signup";
  if (isSessionStart && upstream.ok && data?.session_token) {
    const { session_token, ...rest } = data;
    const res = NextResponse.json(rest, { status: upstream.status });
    res.cookies.set(COOKIE, session_token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(data.expires_at)
    });
    return res;
  }

  const res = upstream.status === 204 ? new NextResponse(null, { status: 204 }) : NextResponse.json(data, { status: upstream.status });
  if (path === "auth/logout") res.cookies.delete(COOKIE);
  return res;
}

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
