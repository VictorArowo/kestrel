"use client";

import Link from "next/link";
import { useState } from "react";
import type { BacktestSummary, Metrics, Snapshot, StrategySpec, SymbolInfo } from "@/lib/engine";
import { money, num, pct, tone } from "@/lib/format";
import { EquityChart } from "./equity-chart";
import { MetricTable } from "./metrics";

/** How each tool reads in the transcript log. */
export const TOOL_LABELS: Record<string, string> = {
  search_symbols: "search symbols",
  get_snapshots: "check market conditions",
  propose_plan: "propose plan",
  validate_strategy: "validate strategy",
  run_backtest: "backtest",
  optimize_strategy: "optimise parameters",
  save_strategy: "save strategy",
  propose_deployment: "offer paper trading",
};

type ErrorCard = { error: string; issues?: { path: string; message: string }[] };
const isError = (c: unknown): c is ErrorCard => !!c && typeof c === "object" && "error" in c;

export function ToolCard({
  name,
  card,
  canApprove,
  onApprove,
  readOnly = false,
}: {
  name: string;
  card: unknown;
  canApprove: boolean;
  onApprove: () => void;
  /** Demo visitors see the cards without the buttons that change anything. */
  readOnly?: boolean;
}) {
  if (card == null) return null;
  if (isError(card)) return <ErrorView card={card} />;
  switch (name) {
    case "propose_plan":
      return <PlanCard card={card as PlanData} canApprove={canApprove && !readOnly} onApprove={onApprove} />;
    case "run_backtest":
      return <BacktestCard card={card as { strategy: StrategySpec; backtest: BacktestSummary }} />;
    case "optimize_strategy":
      return <OptimizeCard card={card as OptimizeData} />;
    case "save_strategy":
      return <SavedCard card={card as SavedData} />;
    case "propose_deployment":
      return <DeployCard card={card as DeployData} readOnly={readOnly} />;
    case "get_snapshots":
      return <SnapshotsCard card={card as { snapshots: (Snapshot | { symbol: string; error: string })[] }} />;
    case "validate_strategy":
      return <ValidateCard card={card as { ok: boolean; rules: string[]; issues: { path: string; message: string; severity: string }[] }} />;
    case "search_symbols":
      return <SearchCard card={card as { query: string; symbols: SymbolInfo[] }} />;
    default:
      return null;
  }
}

function ErrorView({ card }: { card: ErrorCard }) {
  return (
    <div className="text-xs text-down">
      {card.error}
      {card.issues?.map((i) => (
        <div key={i.path + i.message} className="text-dim">
          <span className="text-down">{i.path}</span> {i.message}
        </div>
      ))}
    </div>
  );
}

type PlanData = { summary: string; steps: string[] };

function PlanCard({ card, canApprove, onApprove }: { card: PlanData; canApprove: boolean; onApprove: () => void }) {
  return (
    <div className="panel p-4 max-w-2xl">
      <p className="prose-agent">{card.summary}</p>
      <ol className="mt-3 space-y-1 text-xs">
        {card.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="text-faint">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      {canApprove && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" onClick={onApprove}>
            Approve plan
          </button>
          <span className="text-2xs text-dim">or reply below with changes</span>
        </div>
      )}
    </div>
  );
}

function BacktestCard({ card }: { card: { strategy: StrategySpec; backtest: BacktestSummary } }) {
  const b = card.backtest;
  const bench = b.benchmark;
  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <span className="text-ink font-medium">{card.strategy.name}</span>
        <span className="text-2xs text-dim">
          {new Date(b.start * 1000).toISOString().slice(0, 10)} to {new Date(b.end * 1000).toISOString().slice(0, 10)}
        </span>
      </div>
      <div className="grid gap-5 md:grid-cols-[1fr_260px]">
        <EquityChart equity={b.equity} benchmark={bench?.equity} benchmarkLabel={bench?.symbol} height={200} />
        <div className="space-y-3">
          <MetricTable metrics={b.metrics} benchmark={bench?.metrics} benchmarkLabel={bench?.symbol} compact />
          <div className="text-2xs text-dim">
            {b.metrics.trades} trades, {pct(b.metrics.win_rate_pct, 0, false)} won, invested {pct(b.metrics.exposure_pct, 0, false)} of the time
          </div>
        </div>
      </div>
      <Rules lines={b.description} />
      {b.warnings.length > 0 && (
        <ul className="mt-2 text-2xs text-amber">
          {b.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Rules({ lines }: { lines: string[] }) {
  return (
    <details className="mt-3 text-xs group">
      <summary className="cursor-pointer text-dim hover:text-ink select-none">rules</summary>
      <ul className="mt-2 space-y-1 prose-agent !text-sm">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </details>
  );
}

type OptRow = {
  values: Record<string, unknown>;
  train: Partial<Record<string, number | null>>;
  validation: Partial<Record<string, number | null>>;
};
type OptimizeData = {
  objective: string;
  combinations: number;
  train_period: string;
  validation_period: string;
  baseline: OptRow;
  best: OptRow[];
};

function OptimizeCard({ card }: { card: OptimizeData }) {
  const keys = Object.keys(card.baseline.values);
  const short = (path: string) => path.split(".").slice(-2).join(".");
  const row = (r: OptRow, label?: string) => (
    <tr key={label ?? JSON.stringify(r.values)} className="border-t border-line">
      {keys.map((k) => (
        <td key={k} className="py-1 pr-4">
          {String(r.values[k])}
        </td>
      ))}
      <td className="py-1 pr-4 text-right">{num(r.train.sharpe ?? null)}</td>
      <td className={`py-1 pr-4 text-right ${tone(r.train.return_pct)}`}>{pct(r.train.return_pct ?? null)}</td>
      <td className="py-1 pr-4 text-right">{num(r.validation.sharpe ?? null)}</td>
      <td className={`py-1 pr-2 text-right ${tone(r.validation.return_pct)}`}>{pct(r.validation.return_pct ?? null)}</td>
      <td className="py-1 text-2xs text-dim">{label}</td>
    </tr>
  );
  return (
    <div className="panel p-4 overflow-x-auto">
      <div className="text-2xs text-dim mb-2">
        {card.combinations} combinations ranked by {card.objective} on {card.train_period}; validated on{" "}
        {card.validation_period}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-dim text-left">
            {keys.map((k) => (
              <th key={k} className="font-normal pr-4" title={k}>
                {short(k)}
              </th>
            ))}
            <th className="font-normal pr-4 text-right">train sharpe</th>
            <th className="font-normal pr-4 text-right">train</th>
            <th className="font-normal pr-4 text-right">valid. sharpe</th>
            <th className="font-normal pr-2 text-right">valid.</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {row(card.baseline, "as written")}
          {card.best.map((r) => row(r))}
        </tbody>
      </table>
    </div>
  );
}

type SavedData = { strategyId: string; name: string; description: string[]; metrics: Metrics; benchmark: Metrics | null };

function SavedCard({ card }: { card: SavedData }) {
  return (
    <Link href={`/strategies/${card.strategyId}`} className="panel p-3 flex flex-wrap items-center gap-x-6 gap-y-1 hover:border-line-strong max-w-2xl">
      <span className="text-ink">{card.name}</span>
      <span className={`text-xs ${tone(card.metrics.total_return_pct)}`}>{pct(card.metrics.total_return_pct)}</span>
      <span className="text-xs text-dim">sharpe {num(card.metrics.sharpe)}</span>
      <span className="ml-auto text-xs text-amber">open strategy page</span>
    </Link>
  );
}

type DeployData = { strategyId: string; name: string; initialCash: number; note: string; metrics: Metrics };

function DeployCard({ card, readOnly }: { card: DeployData; readOnly: boolean }) {
  const [cash, setCash] = useState(card.initialCash);
  const [state, setState] = useState<{ status: "idle" | "busy" | "done" | "error"; id?: string; error?: string }>({
    status: "idle",
  });
  async function deploy() {
    setState({ status: "busy" });
    const res = await fetch("/api/portfolios", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategyId: card.strategyId, initialCash: cash }),
    });
    const body = await res.json();
    setState(res.ok ? { status: "done", id: body.id } : { status: "error", error: body.error });
  }
  return (
    <div className="panel p-4 max-w-2xl border-amber-deep">
      <div className="text-ink">Paper trade {card.name}</div>
      <p className="text-xs text-dim mt-1">{card.note}</p>
      {readOnly ? (
        <p className="mt-3 text-2xs text-faint">In the demo, only the owner can deploy.</p>
      ) : state.status === "done" ? (
        <Link href={`/portfolios/${state.id}`} className="mt-3 inline-block text-amber text-xs">
          Deployed. Open the portfolio
        </Link>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-dim">
            starting cash
            <input
              type="number"
              min={1000}
              step={1000}
              value={cash}
              onChange={(e) => setCash(Number(e.target.value))}
              className="w-28 h-7 px-2 bg-canvas border border-line-strong rounded-[2px] text-ink"
            />
          </label>
          <button className="btn btn-primary" onClick={deploy} disabled={state.status === "busy" || !(cash >= 1000)}>
            {state.status === "busy" ? "Deploying" : `Deploy with ${money(cash)}`}
          </button>
          {state.status === "error" && <span className="text-xs text-down">{state.error}</span>}
        </div>
      )}
    </div>
  );
}

function SnapshotsCard({ card }: { card: { snapshots: (Snapshot | { symbol: string; error: string })[] } }) {
  return (
    <div className="panel px-4 py-2 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-dim text-left">
            <th className="font-normal py-1 pr-4">symbol</th>
            <th className="font-normal py-1 pr-4 text-right">close</th>
            <th className="font-normal py-1 pr-4 text-right">1m</th>
            <th className="font-normal py-1 pr-4 text-right">3m</th>
            <th className="font-normal py-1 pr-4 text-right">1y</th>
            <th className="font-normal py-1 pr-4 text-right">rsi 14</th>
            <th className="font-normal py-1 text-right">vs sma 200</th>
          </tr>
        </thead>
        <tbody>
          {card.snapshots.map((s) =>
            "error" in s ? (
              <tr key={s.symbol} className="border-t border-line">
                <td className="py-1 pr-4">{s.symbol}</td>
                <td colSpan={6} className="py-1 text-down">
                  {s.error}
                </td>
              </tr>
            ) : (
              <tr key={s.symbol} className="border-t border-line">
                <td className="py-1 pr-4" title={s.name ?? undefined}>
                  {s.symbol}
                </td>
                <td className="py-1 pr-4 text-right">{num(s.close)}</td>
                <td className={`py-1 pr-4 text-right ${tone(s.return_1m_pct)}`}>{pct(s.return_1m_pct)}</td>
                <td className={`py-1 pr-4 text-right ${tone(s.return_3m_pct)}`}>{pct(s.return_3m_pct)}</td>
                <td className={`py-1 pr-4 text-right ${tone(s.return_1y_pct)}`}>{pct(s.return_1y_pct)}</td>
                <td className="py-1 pr-4 text-right">{num(s.rsi_14, 0)}</td>
                <td className={`py-1 text-right ${tone(s.sma_200 ? s.close - s.sma_200 : null)}`}>
                  {s.sma_200 ? pct((s.close / s.sma_200 - 1) * 100) : "—"}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function ValidateCard({ card }: { card: { ok: boolean; rules: string[]; issues: { path: string; message: string; severity: string }[] } }) {
  if (card.ok && card.issues.length === 0) return <div className="text-2xs text-dim">valid</div>;
  return (
    <div className="text-xs space-y-0.5">
      {card.issues.map((i) => (
        <div key={i.path + i.message}>
          <span className={i.severity === "error" ? "text-down" : "text-amber"}>{i.path}</span>{" "}
          <span className="text-dim">{i.message}</span>
        </div>
      ))}
    </div>
  );
}

function SearchCard({ card }: { card: { query: string; symbols: SymbolInfo[] } }) {
  return (
    <div className="text-2xs text-dim flex flex-wrap gap-x-3 gap-y-0.5">
      {card.symbols.slice(0, 24).map((s) => (
        <span key={s.symbol} title={`${s.name} · ${s.sector}`}>
          <span className="text-ink">{s.symbol}</span> {s.name}
        </span>
      ))}
    </div>
  );
}
