import type { Metrics } from "@/lib/engine";
import { num, pct, tone } from "@/lib/format";

/** Strategy against benchmark, row by row. Good or bad is judged per row, not by colour alone. */
export function MetricTable({
  metrics,
  benchmark,
  benchmarkLabel = "benchmark",
  compact = false,
}: {
  metrics: Metrics;
  benchmark?: Metrics | null;
  benchmarkLabel?: string;
  compact?: boolean;
}) {
  const rows: [string, (m: Metrics) => string, (m: Metrics) => number | null][] = [
    ["total return", (m) => pct(m.total_return_pct), (m) => m.total_return_pct],
    ["annualised", (m) => pct(m.cagr_pct), (m) => m.cagr_pct],
    ["sharpe", (m) => num(m.sharpe), () => null],
    ["max drawdown", (m) => pct(m.max_drawdown_pct), (m) => m.max_drawdown_pct],
  ];
  if (!compact) rows.push(["volatility", (m) => pct(m.volatility_pct, 1, false), () => null]);

  return (
    <table className="w-full text-2xs sm:text-xs">
      <thead>
        <tr className="text-dim text-left">
          <th className="font-normal py-1 pr-4"></th>
          <th className="font-normal py-1 pr-4 text-right">strategy</th>
          {benchmark && <th className="font-normal py-1 text-right">{benchmarkLabel}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, fmt, signed]) => (
          <tr key={label} className="border-t border-line">
            <td className="py-1 pr-4 text-dim">{label}</td>
            <td className={`py-1 pr-4 text-right ${tone(signed(metrics))}`}>{fmt(metrics)}</td>
            {benchmark && <td className={`py-1 text-right ${tone(signed(benchmark))}`}>{fmt(benchmark)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Facts about the strategy's own trading, which have no benchmark equivalent. */
export function TradeStats({ metrics }: { metrics: Metrics }) {
  const items = [
    ["trades", String(metrics.trades)],
    ["win rate", pct(metrics.win_rate_pct, 0, false)],
    ["avg trade", pct(metrics.avg_trade_pct, 2)],
    ["profit factor", num(metrics.profit_factor)],
    ["time invested", pct(metrics.exposure_pct, 0, false)],
  ];
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-2 text-2xs sm:text-xs">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-dim">{k}</dt>
          <dd className="text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
