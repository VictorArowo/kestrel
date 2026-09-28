# Kestrel

A NexusTrade-style AI trading app, built as a portfolio piece: describe a strategy in plain
English, an agent turns it into a JSON strategy, backtests and tunes it, and you can deploy it
to Alpaca paper trading. Not commercial; it doesn't need to be differentiated.

**Read `docs/journal.md` first.** It records every decision and why, and its last entry says
where the build stands and what's next. Add a dated entry after each milestone or notable
finding (bugs, surprising results, design choices). It's source material for a blog post.

## Layout

- `crates/core`: strategy format (`strategy.rs`), validation, English rendering, indicators,
  evaluator, backtester (`decide()` is shared with paper trading), metrics, optimizer.
- `crates/data`: Alpaca daily bars with a JSON cache in `data/cache`, symbol catalog.
- `crates/server`: the `kestrel` binary: `serve` (HTTP API on :7070) and `backtest <file>`.
- `web/`: Next.js 16 app (UI, agent loop with the OpenAI Responses API via the `openai` SDK, SQLite via Drizzle and libSQL; the file is `data/kestrel.db`).
  Next 16 differs from older versions: read `web/node_modules/next/dist/docs/` before
  writing Next code (async `params`, `PageProps<'/route'>`, `RouteContext`).
- `examples/`: strategy files.

## Commands

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p kestrel-server -- serve
cargo run -p kestrel-server -- backtest examples/crypto-trend.json --start 2022-01-01
cd web && npm run dev -- -p 3100   # the app (3000 is taken by another project)
cd web && npm run paper            # paper trading loop; `-- --once` for a single cycle
cd web && npm run typecheck && npm run lint
```

The app's preview tool reads launch configs from the folder this project's first chat started
in (`/Users/victor/Projects/tape/.claude/launch.json`, git-ignored there), which has
`kestrel-engine` and `kestrel-web` entries.

## Conventions

- Backtests stay honest: decide after the close, fill at the next open, slippage and fees on,
  causal indicators. Don't add shortcuts that peek ahead.
- Validation messages are written for the agent to act on, with paths like
  `rules[0].when.all[1]`.
- Secrets live in `.env` (see `.env.example`); never put keys in chat or commits.
- The agent may propose a paper deployment, but only a user click deploys.
