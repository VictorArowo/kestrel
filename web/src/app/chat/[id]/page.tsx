import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { conversations, db, toolRuns } from "@/db";
import { Chat } from "@/components/chat";
import { Replay } from "@/components/replay";
import { VisibilityToggle } from "@/components/visibility-toggle";
import { isOwner } from "@/lib/owner";
import { toBlocks } from "@/lib/transcript";
import type { ConversationStatus } from "@/agent/run";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/chat/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const c = await db.query.conversations.findFirst({ where: eq(conversations.id, id), columns: { title: true, public: true } }).catch(() => null);
  return { title: c && (c.public || (await isOwner())) ? c.title : "Chat" };
}

export default async function ChatPage(props: PageProps<"/chat/[id]">) {
  const { id } = await props.params;
  const { q } = await props.searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const conversation = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
  const owner = await isOwner();
  if (!conversation || (!owner && !conversation.public)) notFound();
  const runs = await db.select().from(toolRuns).where(eq(toolRuns.conversationId, id));
  const cards = Object.fromEntries(runs.map((r) => [r.callId, r.data]));
  const blocks = toBlocks(conversation.items, cards);
  if (!owner) return <Replay blocks={blocks} />;
  return (
    <>
      <div className="max-w-[860px] mx-auto flex justify-end mb-3">
        <VisibilityToggle id={id} initial={conversation.public} />
      </div>
      <Chat
      conversationId={id}
      initialBlocks={blocks}
      initialStatus={conversation.status as ConversationStatus}
      autoSend={typeof q === "string" ? q : undefined}
      />
    </>
  );
}
