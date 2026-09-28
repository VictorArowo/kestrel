// The agent's tools. Each returns a compact `output` for the model and a fuller `card` for the
// UI, so equity curves and trade lists never cost the model tokens.

import type { FunctionTool } from "openai/resources/responses/responses";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, strategies } from "@/db";
import {
  type BacktestResponse,
  type Metrics,
  type Point,
  EngineError,
  engine,
  summarize,
} from "@/lib/engine";

export type ToolContext = { conversationId: string };

export type ToolResult = {
  /** Sent back to the model as the function call output. */
  output: unknown;
  /** Stored for the UI. */
  card: unknown;
  /** End the agent's turn after this call (the user needs to respond). */
  stop?: boolean;
};

type Tool<S extends z.ZodType> = {
  definition: FunctionTool;
  schema: S;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
};

function tool<S extends z.ZodType>(t: Tool<S>): Tool<S> {
  return t;
}

const strategyParam = {
  type: "string",
  description: "The strategy document as a JSON string.",
} as const;

const dateParam = (what: string) => ({ type: "string", description: `${what}, YYYY-MM-DD.` }) as const;

function parseStrategy(json: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch (e) {
    return { ok: false, error: `the strategy isn't valid JSON: ${(e as Error).message}` };
  }
}

function failure(e: unknown): ToolResult {
  if (e instanceof EngineError) {
    const output = { error: e.message, issues: e.issues.length ? e.issues : undefined };
    return { output, card: output };
  }
  throw e;
}

const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

function compactMetrics(m: Metrics) {
  return {
    return_pct: r2(m.total_return_pct),
    cagr_pct: r2(m.cagr_pct),
    sharpe: r2(m.sharpe),
    max_drawdown_pct: r2(m.max_drawdown_pct),
    volatility_pct: r2(m.volatility_pct),
    trades: m.trades,
    win_rate_pct: r2(m.win_rate_pct),
    avg_trade_pct: r2(m.avg_trade_pct),
    profit_factor: r2(m.profit_factor),
    exposure_pct: r2(m.exposure_pct),
  };
}

export function isoDate(t: number) {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

/** Percent change per calendar year, from each year's first to last point. */
export function yearlyReturns(points: Point[]): Map<number, number> {
  const out = new Map<number, number>();
  let prev: Point | null = null;
  let base: Point | null = null;
  let currentYear = NaN;
  for (const p of points) {
    const year = new Date(p.t * 1000).getUTCFullYear();
    if (year !== currentYear) {
      // Measure from the previous year's last close so no day falls between years.
      currentYear = year;
      base = prev ?? p;
    }
    out.set(year, (p.v / base!.v - 1) * 100);
    prev = p;
  }
  return out;
}

function backtestOutput(r: BacktestResponse) {
  const res = r.result;
  const strat = yearlyReturns(res.equity);
  const bench = res.benchmark ? yearlyReturns(res.benchmark.equity) : new Map<number, number>();
  return {
    period: `${isoDate(res.start)} to ${isoDate(res.end)}`,
    rules: r.description,
    metrics: compactMetrics(res.metrics),
    benchmark: res.benchmark && { symbol: res.benchmark.symbol, ...compactMetrics(res.benchmark.metrics) },
    yearly: [...strat].map(([year, v]) => ({ year, strategy_pct: r2(v), benchmark_pct: r2(bench.get(year)) })),
    open_positions: res.holdings.map((h) => h.symbol),
    warnings: [...res.warnings, ...r.warnings.map((w) => `${w.path}: ${w.message}`)],
  };
}

export const tools = {
  search_symbols: tool({
    definition: {
      type: "function",
      name: "search_symbols",
      description:
        "Search the symbol catalog by ticker, company name or sector (e.g. 'semiconductor', 'energy', 'bitcoin'). Returns well-known US stocks, ETFs and crypto pairs.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Ticker, name or sector. Empty lists everything." },
          kind: { type: "string", enum: ["stock", "etf", "crypto", "any"] },
        },
        required: ["query", "kind"],
        additionalProperties: false,
      },
    },
    schema: z.object({ query: z.string(), kind: z.enum(["stock", "etf", "crypto", "any"]) }),
    async run({ query, kind }) {
      try {
        const symbols = await engine.symbols(query, kind === "any" ? undefined : kind);
        return { output: symbols.map((s) => `${s.symbol} ${s.name} (${s.kind}, ${s.sector})`), card: { query, symbols } };
      } catch (e) {
        return failure(e);
      }
    },
  }),

  get_snapshots: tool({
    definition: {
      type: "function",
      name: "get_snapshots",
      description:
        "Current conditions for up to 10 symbols: last close, 1m/3m/6m/1y returns, SMA 50/200, RSI(14), 20-day volatility, 52-week range.",
      strict: true,
      parameters: {
        type: "object",
        properties: { symbols: { type: "array", items: { type: "string" }, description: "Up to 10 symbols." } },
        required: ["symbols"],
        additionalProperties: false,
      },
    },
    schema: z.object({ symbols: z.array(z.string()).min(1).max(10) }),
    async run({ symbols }) {
      const results = await Promise.all(
        symbols.map((s) =>
          engine.snapshot(s).catch((e) => ({ symbol: s, error: e instanceof EngineError ? e.message : String(e) })),
        ),
      );
      const output = results.map((r) =>
        "error" in r
          ? r
          : Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? r2(v) : v])),
      );
      return { output, card: { snapshots: results } };
    },
  }),

  propose_plan: tool({
    definition: {
      type: "function",
      name: "propose_plan",
      description:
        "Show the user your plan for a new strategy and wait for their approval. Your turn ends after this call; continue when they reply.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One or two sentences on the strategy you intend to build." },
          steps: { type: "array", items: { type: "string" }, description: "3-6 short steps." },
        },
        required: ["summary", "steps"],
        additionalProperties: false,
      },
    },
    schema: z.object({ summary: z.string(), steps: z.array(z.string()) }),
    async run(args) {
      return { output: "The plan is shown to the user. Wait for their reply.", card: args, stop: true };
    },
  }),

  validate_strategy: tool({
    definition: {
      type: "function",
      name: "validate_strategy",
      description: "Check a strategy document and get it back in plain English, with any errors and their paths.",
      strict: true,
      parameters: {
        type: "object",
        properties: { strategy: strategyParam },
        required: ["strategy"],
        additionalProperties: false,
      },
    },
    schema: z.object({ strategy: z.string() }),
    async run({ strategy }) {
      const parsed = parseStrategy(strategy);
      if (!parsed.ok) return { output: { error: parsed.error }, card: { error: parsed.error } };
      try {
        const r = await engine.validate(parsed.value);
        const output = { ok: r.ok, rules: r.description, issues: r.issues };
        return { output, card: output };
      } catch (e) {
        return failure(e);
      }
    },
  }),

  run_backtest: tool({
    definition: {
      type: "function",
      name: "run_backtest",
      description:
        "Backtest a strategy on daily bars: decisions after each close, fills at the next open with slippage and fees. Returns metrics, the benchmark and yearly returns.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          strategy: strategyParam,
          start: dateParam("First day"),
          end: { type: ["string", "null"], description: "Last day, YYYY-MM-DD, or null for the latest data." },
        },
        required: ["strategy", "start", "end"],
        additionalProperties: false,
      },
    },
    schema: z.object({ strategy: z.string(), start: z.string(), end: z.string().nullable() }),
    async run({ strategy, start, end }) {
      const parsed = parseStrategy(strategy);
      if (!parsed.ok) return { output: { error: parsed.error }, card: { error: parsed.error } };
      try {
        const r = await engine.backtest(parsed.value, start, end);
        return { output: backtestOutput(r), card: { strategy: parsed.value, backtest: summarize(r) } };
      } catch (e) {
        return failure(e);
      }
    },
  }),

  optimize_strategy: tool({
    definition: {
      type: "function",
      name: "optimize_strategy",
      description:
        "Grid-search 1-3 parameters. Ranks combinations on the first 70% of the period and reports the last 30% (validation) for each. Max 500 combinations.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          strategy: strategyParam,
          start: dateParam("First day"),
          end: { type: ["string", "null"], description: "Last day, YYYY-MM-DD, or null for the latest data." },
          params: {
            type: "array",
            description: "Parameters to vary.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Path into the strategy, e.g. rules[0].when.lt[1]." },
                values: { type: "array", items: { type: "number" } },
              },
              required: ["path", "values"],
              additionalProperties: false,
            },
          },
          objective: { type: "string", enum: ["sharpe", "return", "calmar"] },
        },
        required: ["strategy", "start", "end", "params", "objective"],
        additionalProperties: false,
      },
    },
    schema: z.object({
      strategy: z.string(),
      start: z.string(),
      end: z.string().nullable(),
      params: z.array(z.object({ path: z.string(), values: z.array(z.number()) })).min(1).max(3),
      objective: z.enum(["sharpe", "return", "calmar"]),
    }),
    async run({ strategy, start, end, params, objective }) {
      const parsed = parseStrategy(strategy);
      if (!parsed.ok) return { output: { error: parsed.error }, card: { error: parsed.error } };
      try {
        const r = await engine.optimize({ strategy: parsed.value, start, end, params, objective, top: 5 });
        const row = (c: (typeof r.best)[number]) => ({
          values: Object.fromEntries(params.map((p, i) => [p.path, c.values[i]])),
          train: compactMetrics(c.train),
          validation: compactMetrics(c.validation),
        });
        const output = {
          objective,
          combinations: r.combinations,
          invalid: r.invalid,
          train_period: `${isoDate(r.train_period[0])} to ${isoDate(r.train_period[1])}`,
          validation_period: `${isoDate(r.validation_period[0])} to ${isoDate(r.validation_period[1])}`,
          baseline: row(r.baseline),
          best: r.best.map(row),
        };
        return { output, card: output };
      } catch (e) {
        return failure(e);
      }
    },
  }),

  save_strategy: tool({
    definition: {
      type: "function",
      name: "save_strategy",
      description:
        "Save the final version of a strategy with a full backtest, so the user gets a strategy page and can deploy it. Returns the strategy id.",
      strict: true,
      parameters: {
        type: "object",
        properties: { strategy: strategyParam, start: dateParam("Backtest start") },
        required: ["strategy", "start"],
        additionalProperties: false,
      },
    },
    schema: z.object({ strategy: z.string(), start: z.string() }),
    async run({ strategy, start }, ctx) {
      const parsed = parseStrategy(strategy);
      if (!parsed.ok) return { output: { error: parsed.error }, card: { error: parsed.error } };
      try {
        const r = await engine.backtest(parsed.value, start);
        const spec = (await engine.validate(parsed.value)).strategy!;
        const [row] = await db
          .insert(strategies)
          .values({
            conversationId: ctx.conversationId,
            name: spec.name,
            spec,
            description: r.description,
            backtest: summarize(r),
          })
          .returning({ id: strategies.id });
        const output = { strategy_id: row.id, url: `/strategies/${row.id}`, metrics: compactMetrics(r.result.metrics) };
        return {
          output,
          card: { strategyId: row.id, name: spec.name, description: r.description, metrics: r.result.metrics, benchmark: r.result.benchmark?.metrics ?? null },
        };
      } catch (e) {
        return failure(e);
      }
    },
  }),

  propose_deployment: tool({
    definition: {
      type: "function",
      name: "propose_deployment",
      description:
        "Offer to paper trade a saved strategy. Shows the user a Deploy button; only they can deploy. Use once per strategy.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          strategy_id: { type: "string" },
          initial_cash: { type: "number", description: "Paper dollars to start with, e.g. 25000." },
          note: { type: "string", description: "One sentence on what to watch for once it's live." },
        },
        required: ["strategy_id", "initial_cash", "note"],
        additionalProperties: false,
      },
    },
    schema: z.object({ strategy_id: z.string().uuid(), initial_cash: z.number().positive(), note: z.string() }),
    async run({ strategy_id, initial_cash, note }) {
      const s = await db.query.strategies.findFirst({ where: eq(strategies.id, strategy_id) });
      if (!s) {
        const output = { error: `no saved strategy with id ${strategy_id}; call save_strategy first` };
        return { output, card: output };
      }
      return {
        output: "The user sees a Deploy button. They decide; don't ask again unless they bring it up.",
        card: { strategyId: s.id, name: s.name, initialCash: initial_cash, note, metrics: s.backtest.metrics },
      };
    },
  }),
};

export type ToolName = keyof typeof tools;

export const toolDefinitions: FunctionTool[] = Object.values(tools).map((t) => t.definition);

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  const t = tools[name as ToolName] as Tool<z.ZodType> | undefined;
  if (!t) {
    const output = { error: `unknown tool ${name}` };
    return { output, card: output };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawArgs);
  } catch {
    const output = { error: "the arguments weren't valid JSON", arguments: rawArgs };
    return { output, card: output };
  }
  const args = t.schema.safeParse(json);
  if (!args.success) {
    const output = { error: "invalid arguments", issues: args.error.issues };
    return { output, card: output };
  }
  return t.run(args.data, ctx);
}
