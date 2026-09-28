import { NextResponse, type NextRequest } from "next/server";
import { OWNER_COOKIE, demoMode, ownerCookieValue, tokenMatches } from "@/lib/owner";

/** Sign in as the owner with /owner?token=..., or sign out with /owner?signout. */
export async function GET(request: NextRequest) {
  const home = new URL("/", request.url);
  const res = NextResponse.redirect(home);
  if (request.nextUrl.searchParams.has("signout")) {
    res.cookies.delete(OWNER_COOKIE);
    return res;
  }
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!demoMode() || !tokenMatches(token)) return NextResponse.json({ error: "wrong token" }, { status: 403 });
  res.cookies.set(OWNER_COOKIE, ownerCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  return res;
}
