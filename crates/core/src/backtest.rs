//! Replays a strategy over history. Decisions are made after each bar closes and fill at the
//! next bar's open, with slippage and fees. `decide` is the same function paper trading calls.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::bar::{DAY, is_crypto};
use crate::eval::{Ctx, Evaluator, Market, PositionView};
use crate::metrics::{self, Metrics};
use crate::strategy::{Action, RankOrder, Strategy};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestConfig {
    /// First and last bar dates, as unix seconds.
    pub start: i64,
    pub end: i64,
    #[serde(default = "default_cash")]
    pub initial_cash: f64,
    /// Added to buys and taken off sells, in basis points of the open price.
    #[serde(default = "default_slippage")]
    pub slippage_bps: f64,
    #[serde(default)]
    pub stock_fee_bps: f64,
    #[serde(default = "default_crypto_fee")]
    pub crypto_fee_bps: f64,
    /// Defaults to SPY, or BTC/USD for an all-crypto universe.
    #[serde(default)]
    pub benchmark: Option<String>,
}

fn default_cash() -> f64 {
    100_000.0
}
fn default_slippage() -> f64 {
    5.0
}
fn default_crypto_fee() -> f64 {
    25.0
}

impl BacktestConfig {
    pub fn new(start: i64, end: i64) -> Self {
        BacktestConfig {
            start,
            end,
            initial_cash: default_cash(),
            slippage_bps: default_slippage(),
            stock_fee_bps: 0.0,
            crypto_fee_bps: default_crypto_fee(),
            benchmark: None,
        }
    }

    pub fn benchmark_for(&self, s: &Strategy) -> String {
        self.benchmark.clone().unwrap_or_else(|| {
            if s.universe.symbols.iter().all(|sym| is_crypto(sym)) {
                "BTC/USD".into()
            } else {
                "SPY".into()
            }
        })
    }

    fn fee_rate(&self, symbol: &str) -> f64 {
        (if is_crypto(symbol) {
            self.crypto_fee_bps
        } else {
            self.stock_fee_bps
        }) / 10_000.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub qty: f64,
    pub entry_price: f64,
    pub entry_t: i64,
    /// Fees paid to open, not yet attributed to a closed trade.
    pub entry_fees: f64,
}

/// Cash and open positions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Book {
    pub cash: f64,
    pub positions: BTreeMap<String, Position>,
}

impl Book {
    /// Marked at the latest close at or before `t`.
    pub fn equity(&self, market: &Market, t: i64) -> f64 {
        self.cash
            + self
                .positions
                .iter()
                .map(|(sym, p)| p.qty * market.close_at(sym, t).unwrap_or(p.entry_price))
                .sum::<f64>()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Order {
    pub symbol: String,
    #[serde(flatten)]
    pub kind: OrderKind,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OrderKind {
    /// Open a position with this many dollars.
    Buy { dollars: f64 },
    /// Sell this fraction of the position.
    Sell { fraction: f64 },
    /// Resize the position to this fraction of equity.
    Target { weight: f64 },
}

/// What the strategy wants to do after the bar dated `t` closes. `prev_t` is the previous
/// portfolio-level bar, used by rebalance schedules.
pub fn decide(
    s: &Strategy,
    ev: &Evaluator,
    book: &Book,
    t: i64,
    prev_t: Option<i64>,
) -> Vec<Order> {
    let market = ev.market();
    let mut orders = Vec::new();
    let mut touched: HashSet<&str> = HashSet::new();
    let equity = book.equity(market, t);

    // Stops and targets come first so a rule can't reopen a position the same day.
    for (sym, p) in &book.positions {
        let Some(bar) = market.bar_on(sym, t) else {
            continue;
        };
        let ret = (bar.c / p.entry_price - 1.0) * 100.0;
        let reason = match (s.risk.stop_loss_pct, s.risk.take_profit_pct) {
            (Some(stop), _) if ret <= -stop => "stop loss",
            (_, Some(target)) if ret >= target => "take profit",
            _ => continue,
        };
        orders.push(Order {
            symbol: sym.clone(),
            kind: OrderKind::Sell { fraction: 1.0 },
            reason: reason.into(),
        });
        touched.insert(sym);
    }

    let mut reserved_cash = 0.0;
    let mut open_after = book.positions.len() - orders.len();

    for (i, rule) in s.rules.iter().enumerate() {
        let reason = format!("rule {}", i + 1);
        match &rule.then {
            Action::Buy(_) | Action::Sell(_) => {
                for sym in &s.universe.symbols {
                    if touched.contains(sym.as_str()) || market.bar_on(sym, t).is_none() {
                        continue;
                    }
                    let position = book.positions.get(sym);
                    let kind = match &rule.then {
                        Action::Buy(b) => {
                            if position.is_some()
                                || s.risk.max_positions.is_some_and(|max| open_after >= max)
                            {
                                continue;
                            }
                            let dollars = if let Some(p) = b.percent_of_portfolio {
                                equity * p / 100.0
                            } else if let Some(p) = b.percent_of_cash {
                                (book.cash - reserved_cash).max(0.0) * p / 100.0
                            } else {
                                b.amount.unwrap_or(0.0)
                            };
                            OrderKind::Buy { dollars }
                        }
                        Action::Sell(sell) => {
                            if position.is_none() {
                                continue;
                            }
                            OrderKind::Sell {
                                fraction: sell.percent_of_position.unwrap_or(100.0) / 100.0,
                            }
                        }
                        Action::Rebalance(_) => unreachable!(),
                    };
                    let ctx = symbol_ctx(market, sym, t, position);
                    if !ev.condition(&rule.when, &ctx) {
                        continue;
                    }
                    match kind {
                        OrderKind::Buy { dollars } => {
                            reserved_cash += dollars;
                            open_after += 1;
                        }
                        OrderKind::Sell { fraction } if fraction >= 1.0 => open_after -= 1,
                        _ => {}
                    }
                    orders.push(Order {
                        symbol: sym.clone(),
                        kind,
                        reason: reason.clone(),
                    });
                    touched.insert(sym);
                }
            }
            Action::Rebalance(r) => {
                let ctx = Ctx {
                    t,
                    prev_t,
                    symbol: None,
                    position: None,
                };
                if !ev.condition(&rule.when, &ctx) {
                    continue;
                }
                let mut ranked: Vec<(&String, f64)> = s
                    .universe
                    .symbols
                    .iter()
                    .filter(|sym| is_current(market, sym, t))
                    .filter_map(|sym| {
                        let ctx = symbol_ctx(market, sym, t, book.positions.get(sym));
                        if let Some(f) = &r.filter
                            && !ev.condition(f, &ctx)
                        {
                            return None;
                        }
                        let score = ev.value(&r.by, &ctx);
                        score.is_finite().then_some((sym, score))
                    })
                    .collect();
                ranked.sort_by(|a, b| match r.order {
                    RankOrder::Highest => b.1.total_cmp(&a.1),
                    RankOrder::Lowest => a.1.total_cmp(&b.1),
                });
                let chosen: Vec<&String> = ranked.iter().take(r.top).map(|(s, _)| *s).collect();
                for sym in book.positions.keys() {
                    if !chosen.contains(&sym) && touched.insert(sym) {
                        orders.push(Order {
                            symbol: sym.clone(),
                            kind: OrderKind::Sell { fraction: 1.0 },
                            reason: format!("{reason}: rebalance out"),
                        });
                    }
                }
                let weight = 1.0 / r.top as f64;
                for sym in chosen {
                    if touched.insert(sym) {
                        orders.push(Order {
                            symbol: sym.clone(),
                            kind: OrderKind::Target { weight },
                            reason: format!("{reason}: rebalance"),
                        });
                    }
                }
            }
        }
    }
    orders
}

fn symbol_ctx<'a>(market: &Market, sym: &'a str, t: i64, position: Option<&Position>) -> Ctx<'a> {
    let prev_t = market
        .index_at(sym, t)
        .and_then(|i| i.checked_sub(1))
        .map(|i| market.bars(sym).unwrap()[i].t);
    Ctx {
        t,
        prev_t,
        symbol: Some(sym),
        position: position.map(|p| PositionView {
            entry_price: p.entry_price,
            entry_t: p.entry_t,
        }),
    }
}

/// Has traded in the last week, so it isn't delisted or missing data.
fn is_current(market: &Market, sym: &str, t: i64) -> bool {
    market
        .index_at(sym, t)
        .is_some_and(|i| t - market.bars(sym).unwrap()[i].t <= 7 * DAY)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    pub t: i64,
    pub symbol: String,
    pub side: Side,
    pub qty: f64,
    pub price: f64,
    pub fee: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub symbol: String,
    pub entry_t: i64,
    pub entry_price: f64,
    pub exit_t: i64,
    pub exit_price: f64,
    pub qty: f64,
    /// After fees.
    pub pnl: f64,
    pub return_pct: f64,
    pub days_held: i64,
    pub exit_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Holding {
    pub symbol: String,
    pub qty: f64,
    pub entry_price: f64,
    pub entry_t: i64,
    pub price: f64,
    pub value: f64,
    pub return_pct: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Point {
    pub t: i64,
    pub v: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Benchmark {
    pub symbol: String,
    pub equity: Vec<Point>,
    pub metrics: Metrics,
}

#[derive(Debug, Clone, Serialize)]
pub struct BacktestResult {
    pub start: i64,
    pub end: i64,
    pub initial_cash: f64,
    pub final_equity: f64,
    pub metrics: Metrics,
    pub equity: Vec<Point>,
    pub benchmark: Option<Benchmark>,
    pub trades: Vec<Trade>,
    pub fills: Vec<Fill>,
    pub holdings: Vec<Holding>,
    pub warnings: Vec<String>,
}

pub fn run(s: &Strategy, market: &Market, cfg: &BacktestConfig) -> Result<BacktestResult, String> {
    for sym in s.symbols() {
        if !market.has(&sym) {
            return Err(format!("no market data for {sym}"));
        }
    }
    let mut timeline: Vec<i64> = s
        .universe
        .symbols
        .iter()
        .flat_map(|sym| market.bars(sym).unwrap().iter().map(|b| b.t))
        .filter(|t| *t >= cfg.start && *t <= cfg.end)
        .collect();
    timeline.sort_unstable();
    timeline.dedup();
    if timeline.len() < 2 {
        return Err("not enough bars in the requested period".into());
    }

    let ev = Evaluator::new(market);
    let mut book = Book {
        cash: cfg.initial_cash,
        positions: BTreeMap::new(),
    };
    let mut pending: Vec<(Order, i64)> = Vec::new();
    let mut fills = Vec::new();
    let mut trades = Vec::new();
    let mut equity = Vec::with_capacity(timeline.len());
    let mut exposed = 0usize;
    let mut starved_buys = 0usize;

    for (k, &t) in timeline.iter().enumerate() {
        // Fill yesterday's decisions at today's open.
        let (ready, waiting): (Vec<_>, Vec<_>) = pending
            .into_iter()
            .partition(|(o, decided)| t > *decided && market.bar_on(&o.symbol, t).is_some());
        pending = waiting;
        if !ready.is_empty() {
            let open_equity = book.cash
                + book
                    .positions
                    .iter()
                    .map(|(sym, p)| {
                        let px = market
                            .bar_on(sym, t)
                            .map(|b| b.o)
                            .or_else(|| market.close_at(sym, t - 1));
                        p.qty * px.unwrap_or(p.entry_price)
                    })
                    .sum::<f64>();
            // Resolve targets into buys and sells, then do all sells before any buy.
            let mut sells = Vec::new();
            let mut buys = Vec::new();
            for (o, _) in ready {
                let open = market.bar_on(&o.symbol, t).unwrap().o;
                match o.kind {
                    OrderKind::Sell { fraction } => sells.push((o.symbol, fraction, o.reason)),
                    OrderKind::Buy { dollars } => {
                        if !book.positions.contains_key(&o.symbol) {
                            buys.push((o.symbol, dollars, o.reason));
                        }
                    }
                    OrderKind::Target { weight } => {
                        let current = book.positions.get(&o.symbol).map_or(0.0, |p| p.qty * open);
                        let diff = weight * open_equity - current;
                        if diff.abs() < (open_equity * 0.005).max(1.0) {
                            continue;
                        }
                        if diff < 0.0 {
                            sells.push((o.symbol, -diff / current, o.reason));
                        } else {
                            buys.push((o.symbol, diff, o.reason));
                        }
                    }
                }
            }
            for (sym, fraction, reason) in sells {
                let bar = market.bar_on(&sym, t).unwrap();
                if let Some((fill, trade)) = sell(&mut book, cfg, &sym, fraction, bar.o, t, &reason)
                {
                    fills.push(fill);
                    trades.push(trade);
                }
            }
            for (sym, dollars, reason) in buys {
                let bar = market.bar_on(&sym, t).unwrap();
                match buy(&mut book, cfg, &sym, dollars, bar.o, t, &reason) {
                    Some(fill) => fills.push(fill),
                    None => starved_buys += 1,
                }
            }
        }

        equity.push(Point {
            t,
            v: book.equity(market, t),
        });
        if !book.positions.is_empty() {
            exposed += 1;
        }

        let prev_t = k.checked_sub(1).map(|i| timeline[i]);
        for order in decide(s, &ev, &book, t, prev_t) {
            pending.push((order, t));
        }
    }

    let last_t = *timeline.last().unwrap();
    let holdings = book
        .positions
        .iter()
        .map(|(sym, p)| {
            let price = market.close_at(sym, last_t).unwrap_or(p.entry_price);
            Holding {
                symbol: sym.clone(),
                qty: p.qty,
                entry_price: p.entry_price,
                entry_t: p.entry_t,
                price,
                value: p.qty * price,
                return_pct: (price / p.entry_price - 1.0) * 100.0,
            }
        })
        .collect();

    let mut warnings = Vec::new();
    for sym in &s.universe.symbols {
        let first = market.bars(sym).and_then(|b| b.first()).map(|b| b.t);
        if first.is_some_and(|t| t > timeline[0] + 7 * DAY) {
            let date = chrono::DateTime::from_timestamp(first.unwrap(), 0)
                .unwrap()
                .date_naive();
            warnings.push(format!(
                "{sym} has no data before {date}, so it can't trade before then"
            ));
        }
    }
    if starved_buys > 0 {
        warnings.push(format!("{starved_buys} buys were skipped for lack of cash"));
    }
    if trades.is_empty() && fills.is_empty() {
        warnings.push("the strategy never traded in this period".into());
    }

    let benchmark_symbol = cfg.benchmark_for(s);
    let benchmark = match market.bars(&benchmark_symbol) {
        Some(_) => {
            let first = timeline
                .iter()
                .find_map(|t| market.close_at(&benchmark_symbol, *t));
            first.map(|first| {
                let curve: Vec<Point> = timeline
                    .iter()
                    .map(|t| Point {
                        t: *t,
                        v: cfg.initial_cash
                            * market.close_at(&benchmark_symbol, *t).unwrap_or(first)
                            / first,
                    })
                    .collect();
                Benchmark {
                    symbol: benchmark_symbol,
                    metrics: metrics::compute(&curve, &[], 1.0),
                    equity: curve,
                }
            })
        }
        None => {
            warnings.push(format!("no data for benchmark {benchmark_symbol}"));
            None
        }
    };

    let exposure = exposed as f64 / timeline.len() as f64;
    Ok(BacktestResult {
        start: timeline[0],
        end: last_t,
        initial_cash: cfg.initial_cash,
        final_equity: equity.last().unwrap().v,
        metrics: metrics::compute(&equity, &trades, exposure),
        equity,
        benchmark,
        trades,
        fills,
        holdings,
        warnings,
    })
}

fn buy(
    book: &mut Book,
    cfg: &BacktestConfig,
    sym: &str,
    dollars: f64,
    open: f64,
    t: i64,
    reason: &str,
) -> Option<Fill> {
    let fee_rate = cfg.fee_rate(sym);
    let dollars = dollars.min(book.cash / (1.0 + fee_rate));
    if dollars < 1.0 || open.is_nan() || open <= 0.0 {
        return None;
    }
    let price = open * (1.0 + cfg.slippage_bps / 10_000.0);
    let qty = dollars / price;
    let fee = dollars * fee_rate;
    book.cash -= dollars + fee;
    let p = book.positions.entry(sym.to_string()).or_insert(Position {
        qty: 0.0,
        entry_price: price,
        entry_t: t,
        entry_fees: 0.0,
    });
    p.entry_price = (p.qty * p.entry_price + qty * price) / (p.qty + qty);
    p.qty += qty;
    p.entry_fees += fee;
    Some(Fill {
        t,
        symbol: sym.to_string(),
        side: Side::Buy,
        qty,
        price,
        fee,
        reason: reason.to_string(),
    })
}

fn sell(
    book: &mut Book,
    cfg: &BacktestConfig,
    sym: &str,
    fraction: f64,
    open: f64,
    t: i64,
    reason: &str,
) -> Option<(Fill, Trade)> {
    let p = book.positions.get_mut(sym)?;
    let fraction = fraction.clamp(0.0, 1.0);
    let qty = if fraction >= 0.9999 {
        p.qty
    } else {
        p.qty * fraction
    };
    let price = open * (1.0 - cfg.slippage_bps / 10_000.0);
    let proceeds = qty * price;
    let fee = proceeds * cfg.fee_rate(sym);
    let entry_fees = p.entry_fees * qty / p.qty;
    book.cash += proceeds - fee;
    let pnl = qty * (price - p.entry_price) - fee - entry_fees;
    let trade = Trade {
        symbol: sym.to_string(),
        entry_t: p.entry_t,
        entry_price: p.entry_price,
        exit_t: t,
        exit_price: price,
        qty,
        pnl,
        return_pct: pnl / (qty * p.entry_price) * 100.0,
        days_held: (t - p.entry_t) / DAY,
        exit_reason: reason.to_string(),
    };
    p.qty -= qty;
    p.entry_fees -= entry_fees;
    if p.qty <= 1e-12 {
        book.positions.remove(sym);
    }
    let fill = Fill {
        t,
        symbol: sym.to_string(),
        side: Side::Sell,
        qty,
        price,
        fee,
        reason: reason.to_string(),
    };
    Some((fill, trade))
}
