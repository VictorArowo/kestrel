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
2. Agent route (see the next entry: now OpenAI, not Anthropic): streaming manual tool loop
   with zod validation of every tool input. Tools: search_symbols, get_snapshot, validate_strategy,
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

## 2026-09-28 · Switching the agent to OpenAI

Victor chose OpenAI for the agent instead of Anthropic. Nothing agent-side had been written
yet, so it was a dependency swap (`@anthropic-ai/sdk` → `openai` 7.23) plus doc updates.

- **Model:** `gpt-6-sol`. OpenAI's model list describes it as built for "complex coding and
  agentic workflows" (`gpt-6-astra` is the most capable, `gpt-6-luna` the most efficient).
  It can be overridden with `KESTREL_AGENT_MODEL`.
- **API:** the Responses API, with function tools (`strict: true` JSON schemas) and a manual
  loop: send input, run each `function_call` item, append `function_call_output` items with
  the matching `call_id`, repeat. Reasoning items have to be passed back along with the tool
  outputs.
- **A small lesson:** a summary of OpenAI's docs gave the stream event names as
  `response.text.delta` and `response.reasoning_summary.delta`. The SDK's own type
  definitions say `response.output_text.delta`, `response.reasoning_summary_text.delta` and
  `response.function_call_arguments.delta`. Check the installed types, not the summary.

## 2026-09-28 · Keys in, data depth, and the first full agent run

**Data depth.** Alpaca's free `iex` feed only goes back to **2020-07-27** for stocks (plus one
stray SPY bar from 2018, which showed up as a 634-day gap). Six years is thin for a backtest.
The free plan can also read the `sip` feed (all exchanges) for anything older than 15
minutes, and that goes back to January 2016: 2,680 daily SPY bars. `sip` is now the default,
with an automatic fallback to `iex` if Alpaca refuses it. Crypto history starts in 2021.

**Schema** (Drizzle, `web/src/db/schema.ts`): conversations store the Responses API item
history as JSON and replay it each turn; `tool_runs` stores the full payload behind each tool
call (equity curves, trades) so the UI can draw cards while the model only sees a compact
summary; strategies; portfolios hold a `book` in exactly the engine's shape so it can be sent
straight to a future `/v1/decide`; orders; equity snapshots.

**The agent** (`web/src/agent/`): a manual streaming loop over the Responses API with
`gpt-6-sol`, medium reasoning effort, and reasoning summaries streamed to the UI. Eight tools:
search_symbols, get_snapshots, propose_plan, validate_strategy, run_backtest,
optimize_strategy, save_strategy, propose_deployment. Every tool's arguments are validated
with zod before running. `propose_plan` ends the turn and sets the conversation to
`awaiting_approval`. `propose_deployment` only shows a button. A small but important detail: a
model turn's function calls and their outputs are saved together, because a saved function
call without its output makes the next request fail.

**First run.** Asked for "rotate monthly between SPY, QQQ, TLT and GLD, holding the top 2 by
3-month momentum". It proposed a plan and stopped. After approval it pulled snapshots,
validated, backtested June 2016 to September 2026, saved, and offered paper trading. Its
summary:

> From June 2016 to September 2026, the backtest returned **161% versus 332% for holding
> SPY**. Annualized returns were 9.75% versus 15.24%; maximum drawdown was slightly worse, at
> 35.19% versus 33.79%. [...] This is a faithful test of your rule, but the historical case
> for it over SPY is weak.

It didn't try to tune its way to a better number, and it put the benchmark comparison first.
That's the behaviour the instructions ask for.

**Dev friction:** the app's preview tool reads the launch config of the folder the chat
started in (tape), so the kestrel dev servers are registered there too (that file is
git-ignored). Port 3000 is taken by another project's container, so the web app runs on 3100.

## 2026-09-28 · The UI

**Design.** The Terminal direction, followed literally: black canvas, hairline panels with a
2px radius, amber `#FFB000` as the only accent (brand, prompt caret, primary buttons, focus
rings), green and red only for up and down. Type is Martian Mono at 87.5% width for everything
numeric and structural, plus Instrument Sans for the agent's prose and your prompts, since
paragraphs in a monospace face are tiring. The nav doubles as a function-key strip: `1`-`4`
jump between sections when you're not typing.

**Chart colours were computed, not picked.** The obvious pair (bright amber and a soft blue)
failed a palette validator: too light for a dark surface, and the blue had so little chroma it
read as grey. The pair that passes every check, colour-blind separation included, is
`#C98300` for the strategy and `#4A8AD6` for the benchmark. Bright amber stays for text only.
Both curves are shown as percent return from the start on one axis, so there's never a second
y-scale.

**The chat is a terminal log.** Your messages start with an amber `›`. The model's reasoning
summaries collapse to a single "thinking: ..." line. Each tool call is a log line (◆ while
running, ◇ when done) that opens into a data card: the plan with an Approve button, a
backtest with a chart and a strategy-versus-benchmark table, an optimiser grid showing
training and validation side by side, a market-conditions table, and the deploy card with a
starting-cash input.

**Second live run, through the browser**: "Buy Bitcoin when it closes at a new 50-day high and
sell when it closes below its 20-day average". The agent read "new 50-day high" as a close
above *yesterday's* 50-day high (`offset: 1`), which is the only version that can ever fire,
because today's close is part of today's high. Result: +73.6% against +130.2% for holding
Bitcoin, drawdown −39.7% against −76.7%, 29 trades, "gains were concentrated in 2023–24, so
the result is not evidence of consistent performance." The page was navigated away
mid-run, and the run still finished and saved: the agent keeps going when the browser
disconnects.

Small things caught while looking at it: the chart's canvas can't read CSS variables for its
font; a gap between two percentages is "pts", not "%"; the agent writes Markdown links to
strategy pages, so the renderer now handles links (internal ones only).

## 2026-09-28 · Paper trading

**The loop** (`web/src/paper/cycle.ts`, run by `npm run paper` every 15 minutes or the "Run
paper trading now" button):
1. **Settle:** poll Alpaca for every submitted order; apply fills to the portfolio's book.
2. **Decide:** for each active portfolio with no orders in flight, send its book to the
   engine's new `/v1/decide`, which runs the backtest's own `decide()` on the latest completed
   bar. Each portfolio decides once per bar (`last_decided_t`), so running the loop often is
   harmless.
3. **Send:** turn the engine's intents (buy dollars, sell a fraction, target a weight) into
   Alpaca market orders. Stocks use `day` orders, which Alpaca queues for the next regular
   open when submitted overnight, the same "fill at the next open" the backtest assumes.
   Crypto trades around the clock with `gtc`.
4. **Record** equity at the latest close.

A Postgres advisory lock stops two cycles overlapping (the button and the loop, say). Every
portfolio is a virtual sub-ledger on the one Alpaca paper account.

**A test for the central claim.** "Paper trading makes the same decisions as the backtest" was
true by construction (one function), but that's an argument, not evidence. The new test
replays a 250-day, two-symbol backtest day by day: it rebuilds the book from the backtest's own
fills, calls `decide()` exactly as paper trading does, and checks it asks for exactly the trades
the backtest made the next morning. Every day matched. 18 Rust tests now.

**First live order.** A throwaway strategy ("buy half the portfolio in BTC") on a $1,000
portfolio: decided on the 2026-09-27 close, submitted, filled, settled. The fill looked wrong at
first: $500 notional, but 0.005854688 BTC at $83,773.58 is only $490.47. Alpaca's account cash
confirmed it had charged exactly $490.47: the notional order filled in two pieces totalling
98% of the request. The ledger records fills rather than intents, so it matched Alpaca to the
cent. A useful reminder that live execution doesn't match intent exactly, which is the whole
reason to paper trade before trusting a backtest.

## 2026-09-28 · Deployment detours, and Postgres → SQLite

**Demo mode** landed first: owner sign-in through a secret link (`/owner?token=...`, stored
as a hashed httpOnly cookie), and read-only visitors who see public strategies, portfolios
whose strategy is public, and recorded agent sessions played back as they happened (text
types out, tool calls show "running" before their card appears). Every route that costs
money or changes state checks for the owner server-side, not just in the UI.

**Vercel first.** Victor wanted everything on Vercel, where his other sites live. Vercel's
Rust runtime went into public beta in December 2025, with an Axum adapter, so the engine's
existing router could run as a function almost unchanged (`deploy/engine`). The serverless
constraints showed up one by one:
- No persistent disk: bar cache in `/tmp`, fine for a cache.
- Paper trading can't be a loop: two Vercel Cron jobs instead (after the daily close, and
  after the US open to settle stock fills).
- Postgres advisory locks don't survive a transaction-mode connection pooler: replaced with a
  lease row (`INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at < now`). Tested by firing
  two cycles at once; one ran, one skipped.

**Then: "can we use SQLite, so it's all self-contained?"** Not on Vercel: functions have no
disk that survives, so every write (chats, strategies, paper trades) would vanish. That
reframed the hosting question. A stateful app with a long-running loop fits one small server
better than serverless, while static sites fit Vercel better than a server. The plan became
a hybrid: other sites stay on Vercel, Kestrel moves to a VPS.

**Getting a VPS was its own story.** Hetzner has been restricting new cloud servers since
June 26 because of hardware shortages, for new customers and a random selection of existing
ones, with no workaround. DigitalOcean was next; card payments were being declined at the
time of writing.

**The SQLite switch** (done while that gets sorted) uses libSQL, so one codebase covers both
futures: `DATABASE_URL=file:../data/kestrel.db` on a server, or a Turso URL if Kestrel stays on
Vercel. What changed:
- Schema: `uuid` → text ids generated in code, `jsonb` → JSON-mode text, `timestamp` →
  millisecond integers, `bigint` → integer.
- The lease's `now()` became a comparison with the current time passed in.
- WAL mode and a busy timeout so the app and the paper loop can share the file.
- A one-off script copied everything from Postgres. Nothing was lost: 3 sessions, 20 tool
  cards, 4 strategies, the paper portfolio (cash matched to the cent), its order and equity.
- Docker is no longer needed for local development.

## 2026-09-28 · Onto a VPS

DigitalOcean worked in the end: a Basic droplet in New York, 1 vCPU, 2 GB RAM, 48 GB disk,
Ubuntu 24.04, about $12 a month.

**Server setup**, done over SSH with a new ed25519 key (each machine gets its own key; private
keys never get copied between machines):
- First boot was still running its own updates, which held the package lock; waited for
  cloud-init to finish, then upgraded everything and rebooted onto the new kernel.
- 2 GB swap file, since compiling or a memory spike shouldn't kill the box.
- `ufw`: SSH, HTTP and HTTPS only. Password login was already off; root is now keys-only too.
- Docker with log rotation, and a `deploy` user that owns `/opt/kestrel`.

**Build in CI, not on the server.** The Mac is arm64, the droplet x86_64, and compiling Rust
on 1 vCPU would take ages. GitHub Actions tests, builds both images, pushes them to GHCR,
copies `deploy/compose.yml` over and runs `docker compose up -d`. CI has its own SSH key
(authorised only for `deploy`, host key pinned) and logs the server into the private
registry with the run's short-lived token, then logs out again.

**Four containers:** the engine, the app, Caddy (automatic HTTPS for
kestrel.victorarowo.com), and a `curl` loop that calls the paper trading endpoint every 15
minutes with the cron secret. The loop reuses the endpoint that was built for Vercel Cron, so
that work wasn't wasted.

**Things that broke on the way:**
- `next build` imports every route to collect its config, and importing the database module
  opened the SQLite file, which doesn't exist at build time. The client now connects on first
  query.
- The app image was 2 GB. A `chown -R` at the end of the Dockerfile duplicated every file
  into a new layer; copying files in as the right user instead halved it.
- The first CI run failed its type check: `PageProps`, `LayoutProps` and `RouteContext` are
  generated by Next, and existed locally only because the dev server had made them.
  `npm run typecheck` now runs `next typegen` first.

**Backups:** a nightly `sqlite3 .backup` (consistent even mid-write), gzipped, 14 kept. They
sit on the same disk for now; off-site backups are next.

### To revisit

- **CI is slow.** On the second run: tests about 1.5 min, app image about 2.5 min, and the engine
  image over 4 min, compiling every Rust dependency in release mode on a 2-core runner.
  Docker's layer cache doesn't help because any change to `crates/` invalidates the build
  step. Fixes, by payoff: `cargo-chef` to cache dependencies in their own layer; path
  filters so the engine only rebuilds when `crates/` changes and the app only when `web/`
  does; run tests and builds in parallel.
- **Off-site backups.** Nightly snapshots are on the same disk as the database.
