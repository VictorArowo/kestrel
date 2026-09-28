import { ownerOnly } from "@/lib/owner";
import { conversations, db } from "@/db";

/** Starts a conversation. The first message is sent separately, to the messages route. */
export async function POST(request: Request) {
  const denied = await ownerOnly();
  if (denied) return denied;
  const { text } = (await request.json()) as { text?: string };
  if (!text?.trim()) return Response.json({ error: "say what you'd like to build" }, { status: 400 });
  const title = shorten(text.trim().replace(/\s+/g, " "), 120);
  const [row] = await db.insert(conversations).values({ title }).returning({ id: conversations.id });
  return Response.json({ id: row.id });
}

/** Cuts at a word boundary, so titles never end mid-word. */
function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.]$/, "")}…`;
}
