import { timingSafeEqual } from "node:crypto";
import { ownerOnly } from "@/lib/owner";
import { runCycle } from "@/paper/cycle";

/** The paper trading loop (the `paper` container) calls this with the CRON_SECRET bearer token. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const got = request.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  if (!secret || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(await runCycle());
}

/** The owner's "Run paper trading now" button. */
export async function POST() {
  const denied = await ownerOnly();
  if (denied) return denied;
  return Response.json(await runCycle());
}
