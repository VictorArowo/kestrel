# Kestrel

Describe a trading idea in plain English. An AI agent turns it into rules, backtests them
honestly on up to ten years of daily data, compares the result with just holding the market,
and, if you click Deploy, paper trades it on Alpaca.

It's a portfolio project in the spirit of [NexusTrade](https://nexustrade.io): a Rust engine
for the numbers, a Next.js app for the agent and the UI.

## What makes the numbers honest

- Decisions happen after each daily close and fill at the **next day's open**, with 5 bps
  slippage and 25 bps crypto fees.
- Every indicator only sees bars up to the current one, and a test checks that changing the
  future can't change past decisions.
- Tuning ranks parameters on the first 70% of the period and reports the last 30% it never saw.
- **Paper trading uses the same decision function as the backtest.** A test replays a backtest
  day by day through that function and checks every decision matches.
- The agent has to put the benchmark comparison first. In practice it tells you most ideas lose
  to buying SPY or holding Bitcoin, because most do.

## How it fits together

```
web/ (Next.js 16, TypeScript)
  agent        OpenAI Responses API loop with eight validated tools
  UI           chat with result cards, strategy pages, paper portfolios
  paper/       settles fills, asks the engine for decisions, sends Alpaca paper orders
  SQLite       conversations, strategies, portfolios, orders, equity (Drizzle, libSQL)
        │ HTTP
crates/ (Rust)
  core         strategy format, validation, English rendering, indicators,
               backtester, decide(), metrics, optimizer
  data         Alpaca daily bars with a local cache, symbol catalog
  server       the engine's HTTP API and CLI
```

A strategy is a JSON document the agent writes and the engine validates:

```json
{
  "name": "Oversold large caps",
  "universe": { "symbols": ["AAPL", "MSFT", "NVDA"] },
  "rules": [
    { "when": { "all": [
        { "lt": [{ "rsi": { "period": 14 } }, 30] },
        { "gt": [{ "price": {} }, { "sma": { "period": 200 } }] } ]},
      "then": { "buy": { "percent_of_portfolio": 20 } } },
    { "when": { "gt": [{ "rsi": { "period": 14 } }, 70] }, "then": { "sell": {} } }
  ],
  "risk": { "stop_loss_pct": 10 }
}
```

It renders as: *Buy 20% of the portfolio when RSI(14) < 30 and price > SMA(200). Sell the
position when RSI(14) > 70. Sells any position that falls 10% below its entry.*

## Running it

You need Rust, Node 22, a free [Alpaca](https://alpaca.markets) paper account and an OpenAI
API key. The database is a single SQLite file, `data/kestrel.db`.

```sh
cp .env.example .env               # then add your keys
cd web && npm install && npm run db:migrate && cd ..   # creates data/kestrel.db
cargo run -p kestrel-server -- serve    # the engine, on :7070
cd web && npm run dev -- -p 3100        # the app, on :3100
cd web && npm run paper                 # paper trading loop, every 15 minutes
```

The engine also works on its own:

```sh
cargo run -p kestrel-server -- backtest examples/crypto-trend.json --start 2022-01-01
```

## Development

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd web && npm run typecheck && npm run lint
```

`docs/journal.md` is the build log: every decision, and the bugs and surprises along the way.
