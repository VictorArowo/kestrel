import { eq } from "drizzle-orm";
import { db, portfolios } from "@/db";

/** Pauses, resumes or stops a paper portfolio. A paused portfolio keeps its positions. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/portfolios/[id]">) {
  const { id } = await ctx.params;
  const { status } = (await request.json()) as { status?: string };
  if (!status || !["active", "paused", "stopped"].includes(status)) {
    return Response.json({ error: "status must be active, paused or stopped" }, { status: 400 });
  }
  const [row] = await db.update(portfolios).set({ status }).where(eq(portfolios.id, id)).returning({ id: portfolios.id });
  if (!row) return Response.json({ error: "unknown portfolio" }, { status: 404 });
  return Response.json({ ok: true });
}
