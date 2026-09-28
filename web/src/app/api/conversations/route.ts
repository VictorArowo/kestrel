import { conversations, db } from "@/db";

/** Starts a conversation. The first message is sent separately, to the messages route. */
export async function POST(request: Request) {
  const { text } = (await request.json()) as { text?: string };
  if (!text?.trim()) return Response.json({ error: "say what you'd like to build" }, { status: 400 });
  const title = text.trim().replace(/\s+/g, " ").slice(0, 80);
  const [row] = await db.insert(conversations).values({ title }).returning({ id: conversations.id });
  return Response.json({ id: row.id });
}
