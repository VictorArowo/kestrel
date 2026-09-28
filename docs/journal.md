# Kestrel build journal

Raw notes written as the project was built, meant as source material for a write-up later.
Newest entries at the bottom. Each entry covers what was done, what was decided and why, and
anything surprising.

---

## 2026-09-28 · Why build this

The starting point was [NexusTrade](https://nexustrade.io): you describe a trading idea in
plain English, an AI agent ("Aurora") turns it into a strategy, backtests and tunes it, and you
can deploy it to paper or live trading. Their engineering blog is unusually open. The details
that shaped Kestrel:

- **Strategies are structured configs, not code.** Indicators → conditions → actions. The model
  writes a document, and a deterministic Rust engine runs it. That's easier for an LLM to get
  right, easier to validate, and easy to render back as English.
- **Rust engine, bit-for-bit determinism.** Same inputs, same outputs.
- **Weak spots they admit to:** backtests fill "instantly at the current market price (plus
  simulated slippage)"; one post's disclaimer says results exclude slippage and commissions;
  validation is "multiple time periods" rather than a strict held-out test.

Other platforms surveyed: Composer (no-code "symphonies", bought by SoFi June 2026),
Surmount, Capitalise.ai (bought by Kraken), TrendSpider's AI Strategy Lab, Option Alpha,
QuantConnect (LEAN + the Mia agent + an MCP server), and open-source engines
(NautilusTrader, vectorbt, Freqtrade, Hummingbot, Jesse). Also the LLM-as-trader projects
(TradingAgents, ai-hedge-fund), which are a different idea: the LLM makes each trading
decision instead of writing rules that get tested.

**Goal:** a portfolio piece. It doesn't need to be commercial or different from NexusTrade,
just a clean, honest version of the same loop: English → strategy → backtest → tune → paper trade.

**Name and look:** Kestrel (small fast bird that hovers then strikes). Terminal look: dark,
dense, monospaced numbers, green/red, one amber accent.

## 2026-09-28 · Architecture

- **Rust engine** (`crates/core`, `crates/data`, `crates/server`): strategy format,
  validation, English rendering, indicators, backtester, optimizer, HTTP API. Stateless.
- **Next.js + TypeScript** (`web/`): UI, the agent loop (Anthropic TS SDK), Postgres.
- **Alpaca** for data and paper trading. Its crypto bars don't need API keys (checked with
  curl: stocks return 401 without keys, crypto returns data), which helped: development could
  start before any account existed.

The key design rule: **backtest and paper trading make decisions through the same function**
(`decide()` in `crates/core/src/backtest.rs`). Paper trading can't drift from the backtest
because there's only one implementation of "what does this strategy want to do now".

## 2026-09-28 · The strategy format

A strategy is JSON:

```json
{
  "name": "Oversold large-cap tech",
  "universe": { "symbols": ["AAPL", "MSFT", "NVDA"] },
  "rules": [
    { "when": { "all": [
        { "lt": [{ "rsi": { "period": 14 } }, 30] },
        { "gt": [{ "price": {} }, { "sma": { "period": 200 } }] } ]},
      "then": { "buy": { "percent_of_portfolio": 10 } } },
    { "when": { "gt": [{ "rsi": { "period": 14 } }, 70] }, "then": { "sell": {} } }
  ],
  "risk": { "stop_loss_pct": 8, "max_positions": 5 }
}
```

and renders as:

> Buy 10% of the portfolio when RSI(14) < 30 and price > SMA(200).
> Sell the position when RSI(14) > 70.
> Sells any position that falls 8% below its entry.

Decisions:
- **Rule kinds:** buy and sell rules are checked per symbol, and a `rebalance` rule ranks
  the universe and holds the top N (momentum rotation). That covers NexusTrade's
  buy/sell/rebalance actions.
- **Cross-symbol references:** any indicator can take `"symbol": "SPY"`, so "only when SPY is
  above its 200-day average" works as a regime filter.
- **Errors are written for the agent.** Parsing uses `serde_path_to_error`, so a mistake
  comes back as `rules[0].when.all[1].gt[0]: unknown variant 'rsii', expected one of ...`.
  `Expr` has a hand-written deserializer because serde's untagged enums only say
  "data did not match any variant", which gives the model nothing to fix.
- **Rebalance rules apply to the whole portfolio,** so validation rejects symbol-less
  indicators in their `when`: "SMA(200)" of *what*?

## 2026-09-28 · Honest defaults

Borrowed from an earlier project (tape) that measured how much naive backtests lie:
- Decide after the close, fill at the **next bar's open**.
- 5 bps slippage, 25 bps crypto fees (Alpaca's taker rate), 0 for stocks.
- Every indicator is causal (a test checks that a prefix of the data gives identical values).
- A test replaces all bars after day N and checks that fills and equity up to day N are
  bit-identical. Future data can't leak into past decisions.

Daily bars from different venues are normalised to midnight UTC of their trading date.
Alpaca stamps stock bars at 04:00/05:00 UTC and crypto at 00:00 UTC, so without this a
crypto bar that closes at midnight would appear to exist *before* a stock bar that closed
at 21:00 the previous evening, and cross-asset rules would see a few hours into the future.

## 2026-09-28 · First real backtest, and two surprises

`examples/crypto-trend.json`: hold the two strongest of BTC, ETH, SOL, LINK and AVAX by
30-day return, rebalanced weekly, only while BTC is above its 100-day average.

**Surprise 1: bad data.** The first run's drawdown looked too large, so I scanned the
cached bars. SOL/USD had a daily move of **+680% on 2024-08-26**. Alpaca's SOL/USD history
has a 13-month hole (delisted mid-2023, relisted August 2024). The first bar after the gap
opens at the stale $18 and closes at $157. Any position held across the gap would be
marked at a price that never traded. Fix: for crypto, a gap of more than a week means a
relisting, so history restarts after it (and skips the stale first bar). The backtest now
warns: "SOL/USD has no data before 2024-08-27, so it can't trade before then."

**Surprise 2: the drawdown was real.** Even after the fix, max drawdown was −64.5%. Before
blaming the engine I pulled every fill in the drawdown window (March to October 2024). The
strategy rotated into AVAX ($60 → $26) and LINK ($20 → $12), then got whipsawed around BTC's
100-day average: sell, buy back a week later, sell two days after that, paying 25 bps plus
slippage each way. The engine was right; the strategy was bad. It returned +42.7% over
2022–2026 against +77% for just holding BTC.

That's the kind of result the agent needs to see and say out loud, instead of tuning its way
around it.

## 2026-09-28 · Where things stand (handoff to a new chat)

The research and the engine were built in a chat that started in the old `tape` folder. The
build continues in a chat opened on this folder.

**Done**
- Rust engine: strategy format, validation, English, indicators, backtester, metrics,
  grid optimizer with train/validation split, HTTP API (`/v1/symbols`, `/v1/snapshot`,
  `/v1/bars`, `/v1/validate`, `/v1/backtest`, `/v1/optimize`). 17 tests, clippy clean.
- Next.js 16 app scaffolded in `web/` with `@anthropic-ai/sdk`, `zod`, `drizzle-orm`,
  `postgres`, `lightweight-charts`, `drizzle-kit` installed. Nothing written in it yet.
- Postgres in Docker on port 5439.

**Next, in order**
1. DB schema (Drizzle): conversations (messages as JSON), strategies (spec, English, latest
   backtest), portfolios (virtual sub-ledgers on one Alpaca paper account), orders, equity
   snapshots.
2. Agent route: `claude-opus-5`, adaptive thinking (summarized display), streaming manual tool
   loop, `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), `eager_input_streaming`
   on tools with zod validation. Tools: search_symbols, get_snapshot, validate_strategy,
   run_backtest, optimize, propose_plan (ends the turn, waits for approval), save_strategy,
   propose_deployment (shows a Deploy button; the user's click deploys, not the agent). SSE to
   the browser.
3. UI in the Terminal look: chat with inline result cards, strategy page (English rules,
   equity vs benchmark, metrics, trades), portfolios, explore.
4. Paper trading: add `/v1/decide` to the engine (strategy + book + date → orders, via the
   same `decide()`), and a TS worker that calls it after the close and places Alpaca paper
   orders, then reconciles fills.
5. Demo mode, README, deploy.

**Needs from Victor:** Alpaca paper API keys and an Anthropic API key in `.env` (template in
`.env.example`). Crypto works without Alpaca keys; stocks and paper trading don't.
