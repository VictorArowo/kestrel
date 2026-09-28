import { eq } from "drizzle-orm";
import { conversations, db } from "@/db";
import { ownerOnly } from "@/lib/owner";

/** Shows or hides a conversation in the demo. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/conversations/[id]/visibility">) {
  const denied = await ownerOnly();
  if (denied) return denied;
  const { id } = await ctx.params;
  const { public: isPublic } = (await request.json()) as { public?: boolean };
  if (typeof isPublic !== "boolean") return Response.json({ error: "public must be true or false" }, { status: 400 });
  await db.update(conversations).set({ public: isPublic }).where(eq(conversations.id, id));
  return Response.json({ ok: true });
}
