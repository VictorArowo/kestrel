// Typed client for the Rust engine's HTTP API. The types mirror crates/core.

const ENGINE_URL = process.env.KESTREL_ENGINE_URL ?? `http://127.0.0.1:${process.env.KESTREL_ENGINE_PORT ?? 7070}`;

/** A strategy document. The engine owns the grammar; see crates/core/src/strategy.rs. */
export type StrategySpec = {
  name: string;
  description?: string;
  universe: { symbols: string[] };
  rules: unknown[];
  risk?: { max_positions?: number; stop_loss_pct?: number; take_profit_pct?: number };
};

export type Issue = { path: string; message: string; severity: "error" | "warning" };

export type Metrics = {
  total_return_pct: number;
  cagr_pct: number;
  sharpe: number;
  sortino: number;
  max_drawdown_pct: number;
  volatility_pct: number;
  calmar: number;
  trades: number;
  win_rate_pct: number | null;
  avg_trade_pct: number | null;
  profit_factor: number | null;
  exposure_pct: number;
};

export type Point = { t: number; v: number };

export type Trade = {
  symbol: string;
  entry_t: number;
  entry_price: number;
  exit_t: number;
  exit_price: number;
  qty: number;
  pnl: number;
  return_pct: number;
  days_held: number;
  exit_reason: string;
};

export type Fill = {
  t: number;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  fee: number;
  reason: string;
};

export type Holding = {
  symbol: string;
  qty: number;
  entry_price: number;
  entry_t: number;
  price: number;
  value: number;
  return_pct: number;
};

export type BacktestResult = {
  start: number;
  end: number;
  initial_cash: number;
  final_equity: number;
  metrics: Metrics;
  equity: Point[];
  benchmark: { symbol: string; equity: Point[]; metrics: Metrics } | null;
  trades: Trade[];
  fills: Fill[];
  holdings: Holding[];
  warnings: string[];
};

export type BacktestResponse = { description: string[]; warnings: Issue[]; result: BacktestResult };

export type ValidateResponse = {
  ok: boolean;
  issues: Issue[];
  description: string[];
  strategy: StrategySpec | null;
  symbols: string[];
};

export type Candidate = {
  values: unknown[];
  strategy: StrategySpec;
  train: Metrics;
  validation: Metrics;
};

export type OptimizeResponse = {
  objective: "sharpe" | "return" | "calmar";
  combinations: number;
  invalid: number;
  train_period: [number, number];
  validation_period: [number, number];
  baseline: Candidate;
  best: Candidate[];
};

export type SymbolInfo = { symbol: string; name: string; kind: "stock" | "etf" | "crypto"; sector: string };

export type Snapshot = {
  symbol: string;
  name: string | null;
  sector: string | null;
  date: string;
  close: number;
  return_1m_pct: number | null;
  return_3m_pct: number | null;
  return_6m_pct: number | null;
  return_1y_pct: number | null;
  sma_50: number | null;
  sma_200: number | null;
  rsi_14: number | null;
  volatility_20d_pct: number | null;
  high_52w: number;
  low_52w: number;
};

export type Position = { qty: number; entry_price: number; entry_t: number; entry_fees: number };
export type Book = { cash: number; positions: Record<string, Position> };

export type EngineOrder = { symbol: string; reason: string } & (
  | { type: "buy"; dollars: number }
  | { type: "sell"; fraction: number }
  | { type: "target"; weight: number }
);

/** What we keep of a backtest alongside a saved strategy. */
export type BacktestSummary = Omit<BacktestResult, "fills"> & { description: string[] };

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: { body?: unknown; query?: Record<string, string> }): Promise<T> {
  const url = new URL(path, ENGINE_URL);
  for (const [k, v] of Object.entries(init?.query ?? {})) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.body === undefined ? "GET" : "POST",
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new EngineError(`the engine isn't reachable at ${ENGINE_URL}; is \`kestrel serve\` running?`, 503);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new EngineError(body.error ?? `engine returned ${res.status}`, res.status, body.issues ?? []);
  return body as T;
}

export const engine = {
  symbols: (q: string, kind?: string) =>
    call<{ symbols: SymbolInfo[] }>("/v1/symbols", { query: { q, ...(kind ? { kind } : {}) } }).then((r) => r.symbols),
  snapshot: (symbol: string) => call<Snapshot>("/v1/snapshot", { query: { symbol } }),
  validate: (strategy: unknown) => call<ValidateResponse>("/v1/validate", { body: { strategy } }),
  backtest: (strategy: unknown, start: string, end?: string | null) =>
    call<BacktestResponse>("/v1/backtest", { body: { strategy, start, end: end ?? undefined } }),
  optimize: (body: {
    strategy: unknown;
    start: string;
    end?: string | null;
    params: { path: string; values: unknown[] }[];
    objective?: string;
    top?: number;
  }) => call<OptimizeResponse>("/v1/optimize", { body: { ...body, end: body.end ?? undefined } }),
  decide: (strategy: unknown, book: Book, asOf?: string) =>
    call<DecideResponse>("/v1/decide", { body: { strategy, book, as_of: asOf } }),
};

export type DecideResponse = {
  /** The bar date decided on. */
  t: number;
  date: string;
  prev_t: number | null;
  orders: EngineOrder[];
  /** The book marked at that bar's closes. */
  equity: number;
  prices: Record<string, number | null>;
};

/** Keep charts light: at most `max` points, always including the last. */
export function downsample(points: Point[], max = 400): Point[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out: Point[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out[out.length - 1] = points[points.length - 1];
  return out;
}

export function summarize(r: BacktestResponse): BacktestSummary {
  const { fills: _fills, ...rest } = r.result;
  void _fills;
  return {
    ...rest,
    equity: downsample(rest.equity),
    benchmark: rest.benchmark && { ...rest.benchmark, equity: downsample(rest.benchmark.equity) },
    trades: rest.trades.slice(-250),
    description: r.description,
  };
}
