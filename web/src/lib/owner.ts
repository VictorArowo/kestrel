// Demo mode. With KESTREL_OWNER_TOKEN set, only someone holding the owner cookie can run the
// agent, deploy, or change portfolios; everyone else sees the public demo. Without it (local
// development) everyone is the owner.

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const OWNER_COOKIE = "kestrel_owner";

export function demoMode(): boolean {
  return !!process.env.KESTREL_OWNER_TOKEN;
}

/** What the cookie holds: a hash, so the token itself never sits in the browser. */
export function ownerCookieValue(): string {
  return createHash("sha256").update(`kestrel-owner:${process.env.KESTREL_OWNER_TOKEN}`).digest("hex");
}

export function tokenMatches(candidate: string): boolean {
  const expected = process.env.KESTREL_OWNER_TOKEN;
  if (!expected) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function isOwner(): Promise<boolean> {
  if (!demoMode()) return true;
  const value = (await cookies()).get(OWNER_COOKIE)?.value;
  if (!value) return false;
  const expected = ownerCookieValue();
  return value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

/** For route handlers: a 403 response for visitors, or null for the owner. */
export async function ownerOnly(): Promise<Response | null> {
  if (await isOwner()) return null;
  return Response.json({ error: "this is a read-only demo" }, { status: 403 });
}
