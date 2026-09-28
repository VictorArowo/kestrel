import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { conversations, db, strategies } from "@/db";
import { NewStrategy } from "@/components/new-strategy";
import { StrategyTable } from "@/components/strategy-table";
import { ago } from "@/lib/format";
import { isOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

export default async function Home() {
  const owner = await isOwner();
  const [recentStrategies, recentChats] = await Promise.all([
    db
      .select()
      .from(strategies)
      .where(owner ? undefined : eq(strategies.public, true))
      .orderBy(desc(strategies.createdAt))
      .limit(8),
    db
      .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(owner ? undefined : eq(conversations.public, true))
      .orderBy(desc(conversations.updatedAt))
      .limit(6),
  ]);

  return (
    <div className="space-y-12">
      <section className="max-w-[860px] pt-6">
        <h1 className="font-sans text-3xl sm:text-4xl leading-tight text-ink tracking-tight mb-2" style={{ fontStretch: "100%" }}>
          Describe a trading idea. Kestrel builds it, tests it honestly and paper trades it.
        </h1>
        <p className="text-xs text-dim mb-6 max-w-[70ch]">
          The agent writes your idea as rules, backtests them on up to ten years of daily data with next-day fills, slippage
          and fees, and compares the result with simply holding the market.
        </p>
        {owner ? (
          <NewStrategy />
        ) : (
          <div className="panel p-4">
            <p className="text-xs text-dim mb-3">
              This is a read-only demo. Watch the agent build and test a strategy in one of these recorded sessions:
            </p>
            <ul className="space-y-1.5">
              {recentChats.map((c) => (
                <li key={c.id}>
                  <Link href={`/chat/${c.id}`} className="font-sans text-ink hover:text-amber flex gap-2" style={{ fontStretch: "100%" }}>
                    <span className="text-amber font-mono" aria-hidden>
                      ▸
                    </span>
                    {c.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-dim">Recent strategies</h2>
          <Link href="/strategies" className="text-2xs text-dim hover:text-ink">
            all strategies
          </Link>
        </div>
        <StrategyTable rows={recentStrategies} />
      </section>

      {owner && recentChats.length > 0 && (
        <section>
          <h2 className="text-dim mb-2">Recent chats</h2>
          <ul className="text-xs">
            {recentChats.map((c) => (
              <li key={c.id} className="border-t border-line py-1.5 flex gap-4">
                <Link href={`/chat/${c.id}`} className="text-ink hover:text-amber truncate font-sans" style={{ fontStretch: "100%" }}>
                  {c.title}
                </Link>
                <span className="ml-auto text-faint whitespace-nowrap">{ago(c.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
