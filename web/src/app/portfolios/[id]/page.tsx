import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { db, equitySnapshots, orders, portfolios, strategies } from "@/db";
import { EquityChart } from "@/components/equity-chart";
import { date, money, num, pct, tone } from "@/lib/format";

export const dynamic = "force-dynamic";

async function load(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return (await db.query.portfolios.findFirst({ where: eq(portfolios.id, id) })) ?? null;
}

export async function generateMetadata(props: PageProps<"/portfolios/[id]">): Promise<Metadata> {
  const p = await load((await props.params).id);
  return { title: p ? `${p.name} (paper)` : "Portfolio" };
}

export default async function PortfolioPage(props: PageProps<"/portfolios/[id]">) {
  const p = await load((await props.params).id);
  if (!p) notFound();
  const [strategy, snapshots, recentOrders] = await Promise.all([
    db.query.strategies.findFirst({ where: eq(strategies.id, p.strategyId), columns: { id: true, name: true } }),
    db.select().from(equitySnapshots).where(eq(equitySnapshots.portfolioId, p.id)).orderBy(asc(equitySnapshots.t)),
    db.select().from(orders).where(eq(orders.portfolioId, p.id)).orderBy(desc(orders.createdAt)).limit(50),
  ]);
  const equity = snapshots.map((s) => ({ t: s.t, v: s.equity }));
  const latest = equity.at(-1)?.v ?? p.initialCash;
  const positions = Object.entries(p.book.positions);

  return (
    <article className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-sans text-2xl text-ink tracking-tight" style={{ fontStretch: "100%" }}>
            {p.name} <span className="text-dim text-base">paper</span>
          </h1>
          <p className="text-2xs text-faint mt-1">
            Deployed {p.createdAt.toISOString().slice(0, 10)} with {money(p.initialCash)},{" "}
            <span className={p.status === "active" ? "text-up" : ""}>{p.status}</span>.
            {strategy && (
              <>
                {" "}
                <Link href={`/strategies/${strategy.id}`} className="text-dim hover:text-ink">
                  Strategy page
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl text-ink">{money(latest)}</div>
          <div className={`text-xs ${tone(latest - p.initialCash)}`}>{pct((latest / p.initialCash - 1) * 100, 2)} since deployment</div>
        </div>
      </header>

      <section className="panel p-4">
        {equity.length >= 2 ? (
          <EquityChart equity={equity} height={260} />
        ) : (
          <p className="text-xs text-dim py-8 text-center">
            The equity curve starts after the first market close with this portfolio running.
          </p>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-dim mb-2">Positions</h2>
          {positions.length === 0 ? (
            <p className="text-xs text-dim">All cash: {money(p.book.cash)}.</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {positions.map(([sym, pos]) => (
                  <tr key={sym} className="border-t border-line">
                    <td className="py-1 pr-4">{sym}</td>
                    <td className="py-1 pr-4 text-right">{num(pos.qty, 4)}</td>
                    <td className="py-1 pr-4 text-right text-dim">at {num(pos.entry_price)}</td>
                    <td className="py-1 text-right text-dim">since {date(pos.entry_t)}</td>
                  </tr>
                ))}
                <tr className="border-t border-line">
                  <td className="py-1 pr-4 text-dim">cash</td>
                  <td colSpan={3} className="py-1 text-right">{money(p.book.cash)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h2 className="text-dim mb-2">Orders</h2>
          {recentOrders.length === 0 ? (
            <p className="text-xs text-dim">No orders yet. The strategy is checked after each market close.</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {recentOrders.map((o) => (
                  <tr key={o.id} className="border-t border-line">
                    <td className="py-1 pr-4 text-dim">{date(o.decidedT)}</td>
                    <td className={`py-1 pr-4 ${o.side === "buy" ? "text-up" : "text-down"}`}>{o.side}</td>
                    <td className="py-1 pr-4">{o.symbol}</td>
                    <td className="py-1 pr-4 text-right">{o.fillPrice ? `${num(o.fillQty, 4)} at ${num(o.fillPrice)}` : o.status}</td>
                    <td className="py-1 text-dim">{o.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </article>
  );
}
