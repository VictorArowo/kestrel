//! The strategy format: a JSON document the agent writes, the engine runs and the UI renders as
//! English. Everything here is plain data; evaluation lives in `eval`.

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Strategy {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub universe: Universe,
    pub rules: Vec<Rule>,
    #[serde(default, skip_serializing_if = "Risk::is_empty")]
    pub risk: Risk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Universe {
    pub symbols: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Risk {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_positions: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_loss_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_profit_pct: Option<f64>,
}

impl Risk {
    pub fn is_empty(&self) -> bool {
        self.max_positions.is_none()
            && self.stop_loss_pct.is_none()
            && self.take_profit_pct.is_none()
    }
}

/// When `when` holds, do `then`. Buy and sell rules are checked once per symbol per bar; a
/// rebalance rule is checked once per bar for the whole portfolio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub when: Condition,
    pub then: Action,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    All(Vec<Condition>),
    Any(Vec<Condition>),
    Not(Box<Condition>),
    Gt(Expr, Expr),
    Gte(Expr, Expr),
    Lt(Expr, Expr),
    Lte(Expr, Expr),
    CrossesAbove(Expr, Expr),
    CrossesBelow(Expr, Expr),
    /// True on the first bar of each period.
    Schedule(Frequency),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Quarterly,
}

/// A number, or a value computed from market data or the current position.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Expr {
    Number(f64),
    Series(Box<Series>),
}

// Untagged enums give useless errors ("did not match any variant"), and those errors go straight
// back to the agent, so dispatch on the JSON type by hand.
impl<'de> Deserialize<'de> for Expr {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(d)?;
        match value {
            serde_json::Value::Number(n) => n
                .as_f64()
                .map(Expr::Number)
                .ok_or_else(|| D::Error::custom("number out of range")),
            serde_json::Value::Object(_) => Series::deserialize(value)
                .map(|s| Expr::Series(Box::new(s)))
                .map_err(D::Error::custom),
            other => Err(D::Error::custom(format!(
                "expected a number or an indicator such as {{\"sma\": {{\"period\": 20}}}}, got {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Series {
    /// Closing price.
    Price(Source),
    Open(Source),
    High(Source),
    Low(Source),
    Volume(Source),
    Sma(Windowed),
    Ema(Windowed),
    Rsi(Windowed),
    Atr(Windowed),
    /// Percent change in close over the window.
    Return(Windowed),
    /// Highest close over the window, including the current bar.
    Highest(Windowed),
    /// Lowest close over the window, including the current bar.
    Lowest(Windowed),
    /// Standard deviation of daily percent returns over the window.
    Volatility(Windowed),
    VolumeSma(Windowed),
    Macd(Macd),
    Bollinger(Bollinger),
    /// Unrealised percent return of the open position in this symbol.
    PositionReturn(Empty),
    /// Calendar days since the position in this symbol was opened.
    DaysHeld(Empty),
    Add(Expr, Expr),
    Sub(Expr, Expr),
    Mul(Expr, Expr),
    Div(Expr, Expr),
}

impl Series {
    /// The explicit symbol and bars-ago offset, for series computed from market data.
    pub fn source(&self) -> Option<(Option<&str>, usize)> {
        let (symbol, offset) = match self {
            Series::Price(s)
            | Series::Open(s)
            | Series::High(s)
            | Series::Low(s)
            | Series::Volume(s) => (&s.symbol, s.offset),
            Series::Sma(w)
            | Series::Ema(w)
            | Series::Rsi(w)
            | Series::Atr(w)
            | Series::Return(w)
            | Series::Highest(w)
            | Series::Lowest(w)
            | Series::Volatility(w)
            | Series::VolumeSma(w) => (&w.symbol, w.offset),
            Series::Macd(m) => (&m.symbol, m.offset),
            Series::Bollinger(b) => (&b.symbol, b.offset),
            _ => return None,
        };
        Some((symbol.as_deref(), offset))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    /// Read another symbol's data instead of the one the rule is being checked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// Bars ago; 0 is the latest closed bar.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Windowed {
    pub period: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Macd {
    #[serde(default = "default_12")]
    pub fast: usize,
    #[serde(default = "default_26")]
    pub slow: usize,
    #[serde(default = "default_9")]
    pub signal: usize,
    #[serde(default)]
    pub line: MacdLine,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub offset: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MacdLine {
    #[default]
    Macd,
    Signal,
    Histogram,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bollinger {
    #[serde(default = "default_20")]
    pub period: usize,
    #[serde(default = "default_2f")]
    pub stddev: f64,
    pub band: Band,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Band {
    Upper,
    Middle,
    Lower,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Buy(Buy),
    Sell(Sell),
    Rebalance(Rebalance),
}

/// Opens a position if there isn't one. Exactly one sizing field must be set.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Buy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent_of_portfolio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent_of_cash: Option<f64>,
    /// Dollars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sell {
    /// Defaults to the whole position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent_of_position: Option<f64>,
}

/// Rank the universe by `by`, hold the top `top` at equal weight and sell everything else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rebalance {
    pub top: usize,
    pub by: Expr,
    #[serde(default, skip_serializing_if = "is_default")]
    pub order: RankOrder,
    /// Only symbols for which this holds are eligible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Condition>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RankOrder {
    #[default]
    Highest,
    Lowest,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}

fn default_2f() -> f64 {
    2.0
}
fn default_9() -> usize {
    9
}
fn default_12() -> usize {
    12
}
fn default_20() -> usize {
    20
}
fn default_26() -> usize {
    26
}

/// Parse a strategy, reporting where in the document a problem is.
pub fn parse(value: serde_json::Value) -> Result<Strategy, ParseError> {
    serde_path_to_error::deserialize(value).map_err(|e| ParseError {
        path: e.path().to_string(),
        message: e.into_inner().to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ParseError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

impl Strategy {
    /// Every symbol the strategy needs data for: the universe plus any referenced explicitly.
    pub fn symbols(&self) -> Vec<String> {
        let mut out = self.universe.symbols.clone();
        self.visit_exprs(&mut |e| {
            if let Expr::Series(s) = e
                && let Some((Some(sym), _)) = s.source()
                && !out.iter().any(|o| o == sym)
            {
                out.push(sym.to_string());
            }
        });
        out
    }

    /// Bars of history needed before the first decision for every indicator to be warmed up.
    pub fn lookback(&self) -> usize {
        let mut max = 1;
        self.visit_exprs(&mut |e| {
            if let Expr::Series(s) = e {
                max = max.max(series_lookback(s));
            }
        });
        max
    }

    /// Visits every expression, including nested ones.
    pub fn visit_exprs(&self, f: &mut dyn FnMut(&Expr)) {
        for rule in &self.rules {
            visit_condition(&rule.when, f);
            if let Action::Rebalance(r) = &rule.then {
                visit_expr(&r.by, f);
                if let Some(c) = &r.filter {
                    visit_condition(c, f);
                }
            }
        }
    }
}

pub fn visit_condition(c: &Condition, f: &mut dyn FnMut(&Expr)) {
    match c {
        Condition::All(cs) | Condition::Any(cs) => cs.iter().for_each(|c| visit_condition(c, f)),
        Condition::Not(c) => visit_condition(c, f),
        Condition::Gt(a, b)
        | Condition::Gte(a, b)
        | Condition::Lt(a, b)
        | Condition::Lte(a, b)
        | Condition::CrossesAbove(a, b)
        | Condition::CrossesBelow(a, b) => {
            visit_expr(a, f);
            visit_expr(b, f);
        }
        Condition::Schedule(_) => {}
    }
}

pub fn visit_expr(e: &Expr, f: &mut dyn FnMut(&Expr)) {
    f(e);
    if let Expr::Series(s) = e
        && let Series::Add(a, b) | Series::Sub(a, b) | Series::Mul(a, b) | Series::Div(a, b) =
            s.as_ref()
    {
        visit_expr(a, f);
        visit_expr(b, f);
    }
}

fn series_lookback(s: &Series) -> usize {
    let offset = s.source().map_or(0, |(_, o)| o);
    // Exponential indicators need a few periods to forget their seed; crossovers look one bar back.
    let bars = match s {
        Series::Sma(w) | Series::Highest(w) | Series::Lowest(w) | Series::VolumeSma(w) => w.period,
        Series::Return(w) | Series::Volatility(w) => w.period + 1,
        Series::Ema(w) | Series::Rsi(w) | Series::Atr(w) => w.period * 3,
        Series::Macd(m) => m.slow * 3 + m.signal,
        Series::Bollinger(b) => b.period,
        _ => 1,
    };
    bars + offset + 1
}
