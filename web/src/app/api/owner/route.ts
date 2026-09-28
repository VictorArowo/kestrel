import { OWNER_COOKIE, demoMode, ownerCookieValue, tokenMatches } from "@/lib/owner";
import { cookies } from "next/headers";

/** Signs in as the owner. The token comes in the body, so it never lands in a URL or history. */
export async function POST(request: Request) {
  const { token } = (await request.json().catch(() => ({}))) as { token?: string };
  if (!demoMode()) return Response.json({ error: "sign-in is only needed in the demo" }, { status: 400 });
  if (!token || !tokenMatches(token)) return Response.json({ error: "That token isn't right." }, { status: 403 });
  (await cookies()).set(OWNER_COOKIE, ownerCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  return Response.json({ ok: true });
}

/** Signs out. */
export async function DELETE() {
  (await cookies()).delete(OWNER_COOKIE);
  return Response.json({ ok: true });
}
