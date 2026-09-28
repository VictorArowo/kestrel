//! Checks a parsed strategy makes sense, with messages written for the agent to act on.

use serde::Serialize;

use crate::strategy::{Action, Condition, Expr, Series, Strategy};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    pub path: String,
    pub message: String,
    pub severity: Severity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Error,
    Warning,
}

pub const MAX_SYMBOLS: usize = 50;
pub const MAX_RULES: usize = 20;
pub const MAX_PERIOD: usize = 400;

pub fn validate(s: &Strategy) -> Vec<Issue> {
    let mut v = Validator::default();
    v.strategy(s);
    v.issues
}

pub fn has_errors(issues: &[Issue]) -> bool {
    issues.iter().any(|i| i.severity == Severity::Error)
}

#[derive(Clone, Copy, PartialEq)]
enum Scope {
    /// A buy or sell rule, checked for each symbol in the universe.
    Symbol { buying: bool },
    /// A rebalance rule's `when`, checked once for the whole portfolio.
    Portfolio,
}

#[derive(Default)]
struct Validator {
    issues: Vec<Issue>,
}

impl Validator {
    fn error(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.issues.push(Issue {
            path: path.into(),
            message: message.into(),
            severity: Severity::Error,
        });
    }

    fn warn(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.issues.push(Issue {
            path: path.into(),
            message: message.into(),
            severity: Severity::Warning,
        });
    }

    fn strategy(&mut self, s: &Strategy) {
        if s.name.trim().is_empty() {
            self.error("name", "give the strategy a name");
        }
        let symbols = &s.universe.symbols;
        if symbols.is_empty() {
            self.error("universe.symbols", "the universe needs at least one symbol");
        }
        if symbols.len() > MAX_SYMBOLS {
            self.error("universe.symbols", format!("at most {MAX_SYMBOLS} symbols"));
        }
        for (i, sym) in symbols.iter().enumerate() {
            self.symbol(&format!("universe.symbols[{i}]"), sym);
            if symbols[..i].contains(sym) {
                self.error(
                    format!("universe.symbols[{i}]"),
                    format!("{sym} is listed twice"),
                );
            }
        }

        if s.rules.is_empty() {
            self.error("rules", "add at least one rule");
        }
        if s.rules.len() > MAX_RULES {
            self.error("rules", format!("at most {MAX_RULES} rules"));
        }
        let rebalances = s
            .rules
            .iter()
            .filter(|r| matches!(r.then, Action::Rebalance(_)))
            .count();
        let buys = s
            .rules
            .iter()
            .filter(|r| matches!(r.then, Action::Buy(_)))
            .count();
        if rebalances == 0 && buys == 0 && !s.rules.is_empty() {
            self.warn(
                "rules",
                "no rule ever buys, so this strategy will never hold anything",
            );
        }
        if rebalances > 0 && buys > 0 {
            self.warn("rules", "mixing rebalance and buy rules is allowed, but a rebalance sells whatever it doesn't select, including positions buy rules opened");
        }

        for (i, rule) in s.rules.iter().enumerate() {
            let path = format!("rules[{i}]");
            match &rule.then {
                Action::Buy(b) => {
                    self.condition(
                        &format!("{path}.when"),
                        &rule.when,
                        Scope::Symbol { buying: true },
                    );
                    let set = [b.percent_of_portfolio, b.percent_of_cash, b.amount];
                    let count = set.iter().filter(|x| x.is_some()).count();
                    if count != 1 {
                        self.error(
                            format!("{path}.then.buy"),
                            "set exactly one of percent_of_portfolio, percent_of_cash or amount",
                        );
                    }
                    for (name, pct) in [
                        ("percent_of_portfolio", b.percent_of_portfolio),
                        ("percent_of_cash", b.percent_of_cash),
                    ] {
                        if let Some(p) = pct
                            && !(p > 0.0 && p <= 100.0)
                        {
                            self.error(
                                format!("{path}.then.buy.{name}"),
                                "must be above 0 and at most 100",
                            );
                        }
                    }
                    if let Some(a) = b.amount
                        && !(a > 0.0 && a.is_finite())
                    {
                        self.error(
                            format!("{path}.then.buy.amount"),
                            "must be a positive dollar amount",
                        );
                    }
                }
                Action::Sell(sell) => {
                    self.condition(
                        &format!("{path}.when"),
                        &rule.when,
                        Scope::Symbol { buying: false },
                    );
                    if let Some(p) = sell.percent_of_position
                        && !(p > 0.0 && p <= 100.0)
                    {
                        self.error(
                            format!("{path}.then.sell.percent_of_position"),
                            "must be above 0 and at most 100",
                        );
                    }
                }
                Action::Rebalance(r) => {
                    self.condition(&format!("{path}.when"), &rule.when, Scope::Portfolio);
                    if r.top == 0 || r.top > symbols.len().max(1) {
                        self.error(
                            format!("{path}.then.rebalance.top"),
                            format!(
                                "must be between 1 and the universe size ({})",
                                symbols.len()
                            ),
                        );
                    }
                    self.expr(
                        &format!("{path}.then.rebalance.by"),
                        &r.by,
                        Scope::Symbol { buying: true },
                    );
                    if let Some(f) = &r.filter {
                        self.condition(
                            &format!("{path}.then.rebalance.filter"),
                            f,
                            Scope::Symbol { buying: true },
                        );
                    }
                    if !uses_schedule(&rule.when) {
                        self.warn(
                            format!("{path}.when"),
                            "a rebalance without a schedule (like {\"schedule\": \"monthly\"}) can trade every bar",
                        );
                    }
                }
            }
        }

        if let Some(n) = s.risk.max_positions
            && n == 0
        {
            self.error("risk.max_positions", "must be at least 1");
        }
        if let Some(p) = s.risk.stop_loss_pct
            && !(p > 0.0 && p < 100.0)
        {
            self.error("risk.stop_loss_pct", "must be above 0 and below 100");
        }
        if let Some(p) = s.risk.take_profit_pct
            && !(p > 0.0 && p.is_finite())
        {
            self.error("risk.take_profit_pct", "must be above 0");
        }
    }

    fn symbol(&mut self, path: &str, sym: &str) {
        let ok = !sym.is_empty()
            && sym.len() <= 15
            && sym.chars().all(|c| {
                c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, '.' | '/' | '-')
            });
        if !ok {
            self.error(path, format!("`{sym}` isn't a valid symbol; use uppercase tickers like AAPL or pairs like BTC/USD"));
        }
    }

    fn condition(&mut self, path: &str, c: &Condition, scope: Scope) {
        match c {
            Condition::All(cs) | Condition::Any(cs) => {
                let key = if matches!(c, Condition::All(_)) {
                    "all"
                } else {
                    "any"
                };
                if cs.is_empty() {
                    self.error(format!("{path}.{key}"), "needs at least one condition");
                }
                for (i, c) in cs.iter().enumerate() {
                    self.condition(&format!("{path}.{key}[{i}]"), c, scope);
                }
            }
            Condition::Not(c) => self.condition(&format!("{path}.not"), c, scope),
            Condition::Gt(a, b)
            | Condition::Gte(a, b)
            | Condition::Lt(a, b)
            | Condition::Lte(a, b)
            | Condition::CrossesAbove(a, b)
            | Condition::CrossesBelow(a, b) => {
                let key = condition_key(c);
                self.expr(&format!("{path}.{key}[0]"), a, scope);
                self.expr(&format!("{path}.{key}[1]"), b, scope);
                if matches!(a, Expr::Number(_)) && matches!(b, Expr::Number(_)) {
                    self.warn(
                        format!("{path}.{key}"),
                        "compares two constants, so it never changes",
                    );
                }
            }
            Condition::Schedule(_) => {}
        }
    }

    fn expr(&mut self, path: &str, e: &Expr, scope: Scope) {
        let s = match e {
            Expr::Number(n) => {
                if !n.is_finite() {
                    self.error(path, "must be a finite number");
                }
                return;
            }
            Expr::Series(s) => s.as_ref(),
        };
        let key = series_key(s);
        let path = format!("{path}.{key}");
        match s {
            Series::Add(a, b) | Series::Sub(a, b) | Series::Mul(a, b) | Series::Div(a, b) => {
                self.expr(&format!("{path}[0]"), a, scope);
                self.expr(&format!("{path}[1]"), b, scope);
                return;
            }
            Series::PositionReturn(_) | Series::DaysHeld(_) => {
                match scope {
                    Scope::Portfolio => self.error(&path, "position values only make sense in buy and sell rules"),
                    Scope::Symbol { buying: true } => self.warn(
                        &path,
                        "there is never a position when a buy rule is checked, so this is always unknown and the condition is false",
                    ),
                    Scope::Symbol { buying: false } => {}
                }
                return;
            }
            _ => {}
        }
        let (symbol, offset) = s.source().expect("market series have a source");
        if let Some(sym) = symbol {
            self.symbol(&format!("{path}.symbol"), sym);
        } else if scope == Scope::Portfolio {
            self.error(
                &path,
                "a rebalance rule's `when` applies to the whole portfolio, so indicators in it must name a symbol, like {\"sma\": {\"period\": 200, \"symbol\": \"SPY\"}}",
            );
        }
        if offset > 100 {
            self.error(format!("{path}.offset"), "at most 100 bars back");
        }
        let periods: Vec<(&str, usize)> = match s {
            Series::Sma(w)
            | Series::Ema(w)
            | Series::Rsi(w)
            | Series::Atr(w)
            | Series::Return(w)
            | Series::Highest(w)
            | Series::Lowest(w)
            | Series::Volatility(w)
            | Series::VolumeSma(w) => vec![("period", w.period)],
            Series::Macd(m) => {
                if m.fast >= m.slow {
                    self.error(&path, "fast must be shorter than slow");
                }
                vec![("fast", m.fast), ("slow", m.slow), ("signal", m.signal)]
            }
            Series::Bollinger(b) => {
                if !(b.stddev > 0.0 && b.stddev <= 5.0) {
                    self.error(format!("{path}.stddev"), "must be above 0 and at most 5");
                }
                vec![("period", b.period)]
            }
            _ => vec![],
        };
        for (name, p) in periods {
            let min = if matches!(s, Series::Volatility(_) | Series::Bollinger(_)) {
                2
            } else {
                1
            };
            if p < min || p > MAX_PERIOD {
                self.error(
                    format!("{path}.{name}"),
                    format!("must be between {min} and {MAX_PERIOD}"),
                );
            }
        }
    }
}

fn uses_schedule(c: &Condition) -> bool {
    match c {
        Condition::Schedule(_) => true,
        Condition::All(cs) => cs.iter().any(uses_schedule),
        _ => false,
    }
}

fn condition_key(c: &Condition) -> &'static str {
    match c {
        Condition::All(_) => "all",
        Condition::Any(_) => "any",
        Condition::Not(_) => "not",
        Condition::Gt(..) => "gt",
        Condition::Gte(..) => "gte",
        Condition::Lt(..) => "lt",
        Condition::Lte(..) => "lte",
        Condition::CrossesAbove(..) => "crosses_above",
        Condition::CrossesBelow(..) => "crosses_below",
        Condition::Schedule(_) => "schedule",
    }
}

pub(crate) fn series_key(s: &Series) -> &'static str {
    match s {
        Series::Price(_) => "price",
        Series::Open(_) => "open",
        Series::High(_) => "high",
        Series::Low(_) => "low",
        Series::Volume(_) => "volume",
        Series::Sma(_) => "sma",
        Series::Ema(_) => "ema",
        Series::Rsi(_) => "rsi",
        Series::Atr(_) => "atr",
        Series::Return(_) => "return",
        Series::Highest(_) => "highest",
        Series::Lowest(_) => "lowest",
        Series::Volatility(_) => "volatility",
        Series::VolumeSma(_) => "volume_sma",
        Series::Macd(_) => "macd",
        Series::Bollinger(_) => "bollinger",
        Series::PositionReturn(_) => "position_return",
        Series::DaysHeld(_) => "days_held",
        Series::Add(..) => "add",
        Series::Sub(..) => "sub",
        Series::Mul(..) => "mul",
        Series::Div(..) => "div",
    }
}
