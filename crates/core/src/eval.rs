//! Evaluating conditions and expressions at a point in time. Backtests and paper trading both go
//! through `Evaluator`, so a strategy makes the same decisions on the same bars in either.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use chrono::{DateTime, Datelike};

use crate::bar::{Bar, DAY};
use crate::indicators as ind;
use crate::strategy::{Band, Condition, Expr, Frequency, MacdLine, Series};

/// Daily bars per symbol, sorted by time.
#[derive(Debug, Default, Clone)]
pub struct Market {
    bars: HashMap<String, Vec<Bar>>,
}

impl Market {
    pub fn new(data: HashMap<String, Vec<Bar>>) -> Self {
        let bars = data
            .into_iter()
            .map(|(symbol, mut bars)| {
                bars.sort_by_key(|b| b.t);
                bars.dedup_by_key(|b| b.t);
                (symbol, bars)
            })
            .collect();
        Market { bars }
    }

    pub fn bars(&self, symbol: &str) -> Option<&[Bar]> {
        self.bars.get(symbol).map(Vec::as_slice)
    }

    pub fn has(&self, symbol: &str) -> bool {
        self.bars.contains_key(symbol)
    }

    /// The latest bar closed at or before `t`.
    pub fn index_at(&self, symbol: &str, t: i64) -> Option<usize> {
        let bars = self.bars.get(symbol)?;
        bars.partition_point(|b| b.t <= t).checked_sub(1)
    }

    /// The bar dated exactly `t`.
    pub fn bar_on(&self, symbol: &str, t: i64) -> Option<&Bar> {
        let bars = self.bars.get(symbol)?;
        let i = bars.partition_point(|b| b.t < t);
        bars.get(i).filter(|b| b.t == t)
    }

    /// The latest close at or before `t`.
    pub fn close_at(&self, symbol: &str, t: i64) -> Option<f64> {
        let i = self.index_at(symbol, t)?;
        Some(self.bars[symbol][i].c)
    }
}

/// What a condition is being checked against.
#[derive(Debug, Clone, Copy)]
pub struct Ctx<'a> {
    /// The current bar's date. Only bars dated at or before it are visible.
    pub t: i64,
    /// The previous bar's date, for schedules.
    pub prev_t: Option<i64>,
    /// The symbol a buy or sell rule is being checked for. None for portfolio-level rules.
    pub symbol: Option<&'a str>,
    pub position: Option<PositionView>,
}

#[derive(Debug, Clone, Copy)]
pub struct PositionView {
    pub entry_price: f64,
    pub entry_t: i64,
}

/// A symbol and an indicator with its parameters.
type SeriesId = (String, String);

/// Evaluates against a market, computing each indicator series once per run.
pub struct Evaluator<'a> {
    market: &'a Market,
    cache: RefCell<HashMap<SeriesId, Rc<Vec<f64>>>>,
}

impl<'a> Evaluator<'a> {
    pub fn new(market: &'a Market) -> Self {
        Evaluator {
            market,
            cache: RefCell::default(),
        }
    }

    pub fn market(&self) -> &'a Market {
        self.market
    }

    pub fn condition(&self, c: &Condition, ctx: &Ctx) -> bool {
        self.condition_shifted(c, ctx, 0)
    }

    fn condition_shifted(&self, c: &Condition, ctx: &Ctx, shift: usize) -> bool {
        let cmp = |a: &Expr, b: &Expr, f: fn(f64, f64) -> bool, shift: usize| {
            let (x, y) = (
                self.value_shifted(a, ctx, shift),
                self.value_shifted(b, ctx, shift),
            );
            x.is_finite() && y.is_finite() && f(x, y)
        };
        match c {
            Condition::All(cs) => cs.iter().all(|c| self.condition_shifted(c, ctx, shift)),
            Condition::Any(cs) => cs.iter().any(|c| self.condition_shifted(c, ctx, shift)),
            Condition::Not(c) => !self.condition_shifted(c, ctx, shift),
            Condition::Gt(a, b) => cmp(a, b, |x, y| x > y, shift),
            Condition::Gte(a, b) => cmp(a, b, |x, y| x >= y, shift),
            Condition::Lt(a, b) => cmp(a, b, |x, y| x < y, shift),
            Condition::Lte(a, b) => cmp(a, b, |x, y| x <= y, shift),
            Condition::CrossesAbove(a, b) => {
                cmp(a, b, |x, y| x > y, shift) && cmp(a, b, |x, y| x <= y, shift + 1)
            }
            Condition::CrossesBelow(a, b) => {
                cmp(a, b, |x, y| x < y, shift) && cmp(a, b, |x, y| x >= y, shift + 1)
            }
            Condition::Schedule(f) => match ctx.prev_t {
                None => true,
                Some(prev) => period_id(prev, *f) != period_id(ctx.t, *f),
            },
        }
    }

    /// NaN means "not known yet", and makes any comparison false.
    pub fn value(&self, e: &Expr, ctx: &Ctx) -> f64 {
        self.value_shifted(e, ctx, 0)
    }

    fn value_shifted(&self, e: &Expr, ctx: &Ctx, shift: usize) -> f64 {
        let s = match e {
            Expr::Number(n) => return *n,
            Expr::Series(s) => s.as_ref(),
        };
        match s {
            Series::Add(a, b) => {
                self.value_shifted(a, ctx, shift) + self.value_shifted(b, ctx, shift)
            }
            Series::Sub(a, b) => {
                self.value_shifted(a, ctx, shift) - self.value_shifted(b, ctx, shift)
            }
            Series::Mul(a, b) => {
                self.value_shifted(a, ctx, shift) * self.value_shifted(b, ctx, shift)
            }
            Series::Div(a, b) => {
                let d = self.value_shifted(b, ctx, shift);
                if d == 0.0 {
                    f64::NAN
                } else {
                    self.value_shifted(a, ctx, shift) / d
                }
            }
            Series::PositionReturn(_) => {
                let (Some(symbol), Some(p)) = (ctx.symbol, ctx.position) else {
                    return f64::NAN;
                };
                let Some(i) = self
                    .market
                    .index_at(symbol, ctx.t)
                    .and_then(|i| i.checked_sub(shift))
                else {
                    return f64::NAN;
                };
                (self.market.bars(symbol).unwrap()[i].c / p.entry_price - 1.0) * 100.0
            }
            Series::DaysHeld(_) => match ctx.position {
                Some(p) => ((ctx.t - p.entry_t) / DAY) as f64,
                None => f64::NAN,
            },
            _ => {
                let (explicit, offset) = s.source().expect("market series have a source");
                let Some(symbol) = explicit.or(ctx.symbol) else {
                    return f64::NAN;
                };
                let Some(i) = self
                    .market
                    .index_at(symbol, ctx.t)
                    .and_then(|i| i.checked_sub(offset + shift))
                else {
                    return f64::NAN;
                };
                self.series(symbol, s)[i]
            }
        }
    }

    fn series(&self, symbol: &str, s: &Series) -> Rc<Vec<f64>> {
        let key = (symbol.to_string(), series_key(s));
        if let Some(v) = self.cache.borrow().get(&key) {
            return v.clone();
        }
        let bars = self.market.bars(symbol).unwrap_or(&[]);
        let v = Rc::new(compute(bars, s));
        self.cache.borrow_mut().insert(key, v.clone());
        v
    }
}

fn series_key(s: &Series) -> String {
    match s {
        Series::Price(_) => "close".into(),
        Series::Open(_) => "open".into(),
        Series::High(_) => "high".into(),
        Series::Low(_) => "low".into(),
        Series::Volume(_) => "volume".into(),
        Series::Sma(w) => format!("sma:{}", w.period),
        Series::Ema(w) => format!("ema:{}", w.period),
        Series::Rsi(w) => format!("rsi:{}", w.period),
        Series::Atr(w) => format!("atr:{}", w.period),
        Series::Return(w) => format!("return:{}", w.period),
        Series::Highest(w) => format!("highest:{}", w.period),
        Series::Lowest(w) => format!("lowest:{}", w.period),
        Series::Volatility(w) => format!("volatility:{}", w.period),
        Series::VolumeSma(w) => format!("volume_sma:{}", w.period),
        Series::Macd(m) => format!("macd:{}:{}:{}:{:?}", m.fast, m.slow, m.signal, m.line),
        Series::Bollinger(b) => format!("bollinger:{}:{}:{:?}", b.period, b.stddev, b.band),
        _ => unreachable!("not a market series"),
    }
}

fn compute(bars: &[Bar], s: &Series) -> Vec<f64> {
    let close: Vec<f64> = bars.iter().map(|b| b.c).collect();
    match s {
        Series::Price(_) => close,
        Series::Open(_) => bars.iter().map(|b| b.o).collect(),
        Series::High(_) => bars.iter().map(|b| b.h).collect(),
        Series::Low(_) => bars.iter().map(|b| b.l).collect(),
        Series::Volume(_) => bars.iter().map(|b| b.v).collect(),
        Series::Sma(w) => ind::sma(&close, w.period),
        Series::Ema(w) => ind::ema(&close, w.period),
        Series::Rsi(w) => ind::rsi(&close, w.period),
        Series::Atr(w) => ind::atr(bars, w.period),
        Series::Return(w) => ind::pct_return(&close, w.period),
        Series::Highest(w) => ind::rolling_max(&close, w.period),
        Series::Lowest(w) => ind::rolling_min(&close, w.period),
        Series::Volatility(w) => ind::volatility(&close, w.period),
        Series::VolumeSma(w) => ind::sma(&bars.iter().map(|b| b.v).collect::<Vec<_>>(), w.period),
        Series::Macd(m) => {
            let out = ind::macd(&close, m.fast, m.slow, m.signal);
            match m.line {
                MacdLine::Macd => out.macd,
                MacdLine::Signal => out.signal,
                MacdLine::Histogram => out.histogram,
            }
        }
        Series::Bollinger(b) => {
            let mid = ind::sma(&close, b.period);
            if b.band == Band::Middle {
                return mid;
            }
            let sd = ind::rolling_std(&close, b.period);
            let sign = if b.band == Band::Upper { 1.0 } else { -1.0 };
            mid.iter()
                .zip(&sd)
                .map(|(m, s)| m + sign * b.stddev * s)
                .collect()
        }
        _ => unreachable!("not a market series"),
    }
}

fn period_id(t: i64, f: Frequency) -> i64 {
    let d = DateTime::from_timestamp(t, 0)
        .expect("valid timestamp")
        .date_naive();
    match f {
        Frequency::Daily => t / DAY,
        Frequency::Weekly => {
            let w = d.iso_week();
            w.year() as i64 * 100 + w.week() as i64
        }
        Frequency::Monthly => d.year() as i64 * 12 + d.month0() as i64,
        Frequency::Quarterly => d.year() as i64 * 4 + (d.month0() / 3) as i64,
    }
}
