import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, portfolios, strategies } from "@/db";
import { money } from "@/lib/format";
import { RunCycleButton } from "@/components/portfolio-controls";
import { isOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Portfolios" };

export default async function Portfolios() {
  const owner = await isOwner();
  const rows = await db
    .select({ p: portfolios, strategyName: strategies.name })
    .from(portfolios)
    .innerJoin(strategies, eq(portfolios.strategyId, strategies.id))
    .where(owner ? undefined : eq(strategies.public, true))
    .orderBy(desc(portfolios.createdAt));
  return (
    <div>
      <h1 className="text-dim mb-1">Paper portfolios</h1>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-2xs text-faint">Simulated money on Alpaca&apos;s paper account. Each portfolio trades one strategy after every close.</p>
        {owner && <RunCycleButton />}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-dim">
          Nothing is paper trading yet. Open a <Link href="/strategies" className="text-amber">strategy</Link> and choose Paper trade.
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-dim text-left">
              <th className="font-normal py-1.5 pr-4">portfolio</th>
              <th className="font-normal py-1.5 pr-4">status</th>
              <th className="font-normal py-1.5 pr-4 text-right">started with</th>
              <th className="font-normal py-1.5 pr-4 text-right">cash</th>
              <th className="font-normal py-1.5 text-right">positions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p }) => (
              <tr key={p.id} className="border-t border-line">
                <td className="py-1.5 pr-4">
                  <Link href={`/portfolios/${p.id}`} className="text-ink hover:text-amber">
                    {p.name}
                  </Link>
                </td>
                <td className={`py-1.5 pr-4 ${p.status === "active" ? "text-up" : "text-dim"}`}>{p.status}</td>
                <td className="py-1.5 pr-4 text-right">{money(p.initialCash)}</td>
                <td className="py-1.5 pr-4 text-right">{money(p.book.cash)}</td>
                <td className="py-1.5 text-right">{Object.keys(p.book.positions).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
