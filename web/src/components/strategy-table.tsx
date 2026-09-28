import Link from "next/link";
import type { strategies } from "@/db";
import { num, pct, pts, tone } from "@/lib/format";

type Row = typeof strategies.$inferSelect;

export function StrategyTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-dim">
        No saved strategies yet. Describe one above and the agent will build and test it.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-dim text-left">
            <th className="font-normal py-1.5 pr-4">strategy</th>
            <th className="font-normal py-1.5 pr-4 text-right">return</th>
            <th className="font-normal py-1.5 pr-4 text-right">vs benchmark</th>
            <th className="font-normal py-1.5 pr-4 text-right">annualised</th>
            <th className="font-normal py-1.5 pr-4 text-right">sharpe</th>
            <th className="font-normal py-1.5 pr-4 text-right">max dd</th>
            <th className="font-normal py-1.5 text-right">trades</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const m = s.backtest.metrics;
            const b = s.backtest.benchmark;
            const edge = b ? m.total_return_pct - b.metrics.total_return_pct : null;
            return (
              <tr key={s.id} className="border-t border-line hover:bg-panel">
                <td className="py-1.5 pr-4">
                  <Link href={`/strategies/${s.id}`} className="text-ink hover:text-amber">
                    {s.name}
                  </Link>
                  <div className="text-2xs text-faint truncate max-w-[36ch]">{s.spec.universe.symbols.join(" ")}</div>
                </td>
                <td className={`py-1.5 pr-4 text-right ${tone(m.total_return_pct)}`}>{pct(m.total_return_pct)}</td>
                <td className={`py-1.5 pr-4 text-right ${tone(edge)}`} title={b ? `${b.symbol} ${pct(b.metrics.total_return_pct)}` : undefined}>
                  {edge == null ? "—" : `${pts(edge)} vs ${b!.symbol}`}
                </td>
                <td className={`py-1.5 pr-4 text-right ${tone(m.cagr_pct)}`}>{pct(m.cagr_pct)}</td>
                <td className="py-1.5 pr-4 text-right">{num(m.sharpe)}</td>
                <td className="py-1.5 pr-4 text-right text-down">{pct(m.max_drawdown_pct)}</td>
                <td className="py-1.5 text-right">{m.trades}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
