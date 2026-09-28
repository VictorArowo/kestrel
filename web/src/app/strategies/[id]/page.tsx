import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { db, strategies } from "@/db";
import { DeployButton } from "@/components/deploy-button";
import { EquityChart } from "@/components/equity-chart";
import { MetricTable, TradeStats } from "@/components/metrics";
import { date, money, num, pct, pts, tone } from "@/lib/format";
import { yearlyReturns } from "@/lib/returns";

export const dynamic = "force-dynamic";

async function load(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return (await db.query.strategies.findFirst({ where: eq(strategies.id, id) })) ?? null;
}

export async function generateMetadata(props: PageProps<"/strategies/[id]">): Promise<Metadata> {
  const s = await load((await props.params).id);
  return { title: s?.name ?? "Strategy" };
}

export default async function StrategyPage(props: PageProps<"/strategies/[id]">) {
  const s = await load((await props.params).id);
  if (!s) notFound();
  const b = s.backtest;
  const bench = b.benchmark;
  const years = yearlyReturns(b.equity);
  const benchYears = bench ? yearlyReturns(bench.equity) : new Map<number, number>();
  const trades = [...b.trades].reverse().slice(0, 40);

  return (
    <article className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[70ch]">
          <h1 className="font-sans text-2xl text-ink tracking-tight" style={{ fontStretch: "100%" }}>
            {s.name}
          </h1>
          {s.spec.description && (
            <p className="font-sans text-dim mt-1" style={{ fontStretch: "100%" }}>
              {s.spec.description}
            </p>
          )}
          <p className="text-2xs text-faint mt-2">
            {s.spec.universe.symbols.join(" ")}, backtested {date(b.start)} to {date(b.end)} with {money(b.initial_cash)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {s.conversationId && (
            <Link href={`/chat/${s.conversationId}`} className="btn">
              Open chat
            </Link>
          )}
          <DeployButton strategyId={s.id} />
        </div>
      </header>

      <section className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="panel p-4">
          <EquityChart equity={b.equity} benchmark={bench?.equity} benchmarkLabel={bench?.symbol} height={320} />
        </div>
        <div className="panel p-4 space-y-4">
          <MetricTable metrics={b.metrics} benchmark={bench?.metrics} benchmarkLabel={bench?.symbol} />
          <p className="text-2xs text-dim">
            Ended at {money(b.final_equity)}. Decisions after each close, fills at the next open, 5 bps slippage, crypto fees 25 bps.
          </p>
        </div>
      </section>

      <section className="panel p-4">
        <TradeStats metrics={b.metrics} />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-dim mb-2">Rules</h2>
          <ul className="prose-agent space-y-1">
            {b.description.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {b.warnings.length > 0 && (
            <ul className="mt-3 text-2xs text-amber">
              {b.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="text-dim mb-2">By year</h2>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-dim text-left">
                <th className="font-normal py-1 pr-4">year</th>
                <th className="font-normal py-1 pr-4 text-right">strategy</th>
                {bench && <th className="font-normal py-1 pr-4 text-right">{bench.symbol}</th>}
                {bench && <th className="font-normal py-1 text-right">difference</th>}
              </tr>
            </thead>
            <tbody>
              {[...years].map(([year, v]) => {
                const bv = benchYears.get(year);
                return (
                  <tr key={year} className="border-t border-line">
                    <td className="py-1 pr-4 text-dim">{year}</td>
                    <td className={`py-1 pr-4 text-right ${tone(v)}`}>{pct(v)}</td>
                    {bench && <td className={`py-1 pr-4 text-right ${tone(bv)}`}>{pct(bv)}</td>}
                    {bench && <td className={`py-1 text-right ${tone(bv == null ? null : v - bv)}`}>{bv == null ? "—" : pts(v - bv)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {b.holdings.length > 0 && (
        <section>
          <h2 className="text-dim mb-2">Held at the end of the backtest</h2>
          <table className="w-full text-xs">
            <tbody>
              {b.holdings.map((h) => (
                <tr key={h.symbol} className="border-t border-line">
                  <td className="py-1 pr-4">{h.symbol}</td>
                  <td className="py-1 pr-4 text-dim">since {date(h.entry_t)}</td>
                  <td className="py-1 pr-4 text-right">{money(h.value)}</td>
                  <td className={`py-1 text-right ${tone(h.return_pct)}`}>{pct(h.return_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="overflow-x-auto">
        <h2 className="text-dim mb-2">
          Latest trades <span className="text-faint">({b.metrics.trades} in total)</span>
        </h2>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-dim text-left">
              <th className="font-normal py-1 pr-4">symbol</th>
              <th className="font-normal py-1 pr-4">bought</th>
              <th className="font-normal py-1 pr-4">sold</th>
              <th className="font-normal py-1 pr-4 text-right">days</th>
              <th className="font-normal py-1 pr-4 text-right">entry</th>
              <th className="font-normal py-1 pr-4 text-right">exit</th>
              <th className="font-normal py-1 pr-4 text-right">return</th>
              <th className="font-normal py-1">why it sold</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={`${t.symbol}${t.exit_t}${i}`} className="border-t border-line">
                <td className="py-1 pr-4">{t.symbol}</td>
                <td className="py-1 pr-4 text-dim">{date(t.entry_t)}</td>
                <td className="py-1 pr-4 text-dim">{date(t.exit_t)}</td>
                <td className="py-1 pr-4 text-right">{t.days_held}</td>
                <td className="py-1 pr-4 text-right">{num(t.entry_price)}</td>
                <td className="py-1 pr-4 text-right">{num(t.exit_price)}</td>
                <td className={`py-1 pr-4 text-right ${tone(t.return_pct)}`}>{pct(t.return_pct)}</td>
                <td className="py-1 text-dim">{t.exit_reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <details className="text-xs">
        <summary className="cursor-pointer text-dim hover:text-ink">Strategy document</summary>
        <pre className="panel p-4 mt-2 overflow-x-auto text-2xs text-dim">{JSON.stringify(s.spec, null, 2)}</pre>
      </details>
    </article>
  );
}
