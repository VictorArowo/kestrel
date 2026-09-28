import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { conversations, db } from "@/db";
import { ago } from "@/lib/format";
import { isOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chats" };

export default async function Chats() {
  const owner = await isOwner();
  const rows = await db
    .select({ id: conversations.id, title: conversations.title, status: conversations.status, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(owner ? undefined : eq(conversations.public, true))
    .orderBy(desc(conversations.updatedAt))
    .limit(100);
  return (
    <div className="max-w-[860px]">
      <h1 className="text-dim mb-1">{owner ? "Chats" : "Recorded sessions"}</h1>
      {!owner && <p className="text-2xs text-faint mb-3">Real sessions with the agent, played back as they happened.</p>}
      {rows.length === 0 ? (
        <p className="text-xs text-dim">
          No chats yet. <Link href="/" className="text-amber">Describe a strategy</Link> to start one.
        </p>
      ) : (
        <ul className="text-xs">
          {rows.map((c) => (
            <li key={c.id} className="border-t border-line py-2 flex gap-4">
              <Link href={`/chat/${c.id}`} className="text-ink hover:text-amber truncate font-sans" style={{ fontStretch: "100%" }}>
                {c.title}
              </Link>
              {c.status === "awaiting_approval" && <span className="text-amber whitespace-nowrap">plan waiting</span>}
              <span className="ml-auto text-faint whitespace-nowrap">{ago(c.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
