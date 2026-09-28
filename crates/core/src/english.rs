//! Renders a strategy as plain English, one sentence per rule.

use crate::strategy::{
    Action, Band, Condition, Expr, Frequency, MacdLine, RankOrder, Series, Strategy,
};

pub fn describe(s: &Strategy) -> Vec<String> {
    let mut lines = vec![format!("Trades {}.", list(&s.universe.symbols))];
    for rule in &s.rules {
        let line = match &rule.then {
            Action::Rebalance(_) => format!(
                "{}, {}.",
                capitalise(&condition(&rule.when)),
                action(&rule.then)
            ),
            _ => format!(
                "{}.",
                capitalise(&format!(
                    "{} when {}",
                    action(&rule.then),
                    condition(&rule.when)
                ))
            ),
        };
        lines.push(line);
    }
    if let Some(n) = s.risk.max_positions {
        lines.push(format!(
            "Holds at most {n} position{} at once.",
            if n == 1 { "" } else { "s" }
        ));
    }
    if let Some(p) = s.risk.stop_loss_pct {
        lines.push(format!(
            "Sells any position that falls {}% below its entry.",
            num(p)
        ));
    }
    if let Some(p) = s.risk.take_profit_pct {
        lines.push(format!(
            "Sells any position that rises {}% above its entry.",
            num(p)
        ));
    }
    lines
}

pub fn action(a: &Action) -> String {
    match a {
        Action::Buy(b) => {
            if let Some(p) = b.percent_of_portfolio {
                format!("buy {}% of the portfolio", num(p))
            } else if let Some(p) = b.percent_of_cash {
                format!("buy with {}% of cash", num(p))
            } else if let Some(a) = b.amount {
                format!("buy ${}", money(a))
            } else {
                "buy".into()
            }
        }
        Action::Sell(s) => match s.percent_of_position {
            Some(p) if p < 100.0 => format!("sell {}% of the position", num(p)),
            _ => "sell the position".into(),
        },
        Action::Rebalance(r) => {
            let order = match r.order {
                RankOrder::Highest => "highest",
                RankOrder::Lowest => "lowest",
            };
            let mut out = format!(
                "hold the {} with the {order} {} at equal weight",
                plural(r.top, "symbol"),
                expr(&r.by)
            );
            if let Some(f) = &r.filter {
                out.push_str(&format!(", among those where {}", condition(f)));
            }
            out
        }
    }
}

pub fn condition(c: &Condition) -> String {
    match c {
        Condition::All(cs) => join(cs, " and "),
        Condition::Any(cs) => join(cs, " or "),
        Condition::Not(c) => format!("not ({})", condition(c)),
        Condition::Gt(a, b) => format!("{} > {}", expr(a), expr(b)),
        Condition::Gte(a, b) => format!("{} ≥ {}", expr(a), expr(b)),
        Condition::Lt(a, b) => format!("{} < {}", expr(a), expr(b)),
        Condition::Lte(a, b) => format!("{} ≤ {}", expr(a), expr(b)),
        Condition::CrossesAbove(a, b) => format!("{} crosses above {}", expr(a), expr(b)),
        Condition::CrossesBelow(a, b) => format!("{} crosses below {}", expr(a), expr(b)),
        Condition::Schedule(f) => match f {
            Frequency::Daily => "every day".into(),
            Frequency::Weekly => "at the start of each week".into(),
            Frequency::Monthly => "at the start of each month".into(),
            Frequency::Quarterly => "at the start of each quarter".into(),
        },
    }
}

pub fn expr(e: &Expr) -> String {
    let s = match e {
        Expr::Number(n) => return num(*n),
        Expr::Series(s) => s.as_ref(),
    };
    let base = match s {
        Series::Add(a, b) => return format!("({} + {})", expr(a), expr(b)),
        Series::Sub(a, b) => return format!("({} − {})", expr(a), expr(b)),
        Series::Mul(a, b) => return format!("{} × {}", operand(a), operand(b)),
        Series::Div(a, b) => return format!("{} ÷ {}", operand(a), operand(b)),
        Series::PositionReturn(_) => return "position return %".into(),
        Series::DaysHeld(_) => return "days held".into(),
        Series::Price(_) => "price".into(),
        Series::Open(_) => "open".into(),
        Series::High(_) => "high".into(),
        Series::Low(_) => "low".into(),
        Series::Volume(_) => "volume".into(),
        Series::Sma(w) => format!("SMA({})", w.period),
        Series::Ema(w) => format!("EMA({})", w.period),
        Series::Rsi(w) => format!("RSI({})", w.period),
        Series::Atr(w) => format!("ATR({})", w.period),
        Series::Return(w) => format!("{}-day return %", w.period),
        Series::Highest(w) => format!("{}-day high", w.period),
        Series::Lowest(w) => format!("{}-day low", w.period),
        Series::Volatility(w) => format!("{}-day volatility %", w.period),
        Series::VolumeSma(w) => format!("{}-day average volume", w.period),
        Series::Macd(m) => {
            let line = match m.line {
                MacdLine::Macd => "MACD",
                MacdLine::Signal => "MACD signal",
                MacdLine::Histogram => "MACD histogram",
            };
            format!("{line}({},{},{})", m.fast, m.slow, m.signal)
        }
        Series::Bollinger(b) => {
            let band = match b.band {
                Band::Upper => "upper",
                Band::Middle => "middle",
                Band::Lower => "lower",
            };
            format!("{band} Bollinger({},{})", b.period, num(b.stddev))
        }
    };
    let (symbol, offset) = s.source().unwrap_or((None, 0));
    let mut out = match symbol {
        Some(sym) => format!("{sym} {base}"),
        None => base,
    };
    match offset {
        0 => {}
        1 => out.push_str(" yesterday"),
        n => out.push_str(&format!(" {n} days ago")),
    }
    out
}

fn operand(e: &Expr) -> String {
    expr(e)
}

fn join(cs: &[Condition], sep: &str) -> String {
    cs.iter()
        .map(|c| match c {
            Condition::All(_) | Condition::Any(_) if cs.len() > 1 => format!("({})", condition(c)),
            _ => condition(c),
        })
        .collect::<Vec<_>>()
        .join(sep)
}

fn list(items: &[String]) -> String {
    match items {
        [] => "nothing".into(),
        [one] => one.clone(),
        [init @ .., last] if items.len() <= 8 => format!("{} and {last}", init.join(", ")),
        _ => format!("{} and {} others", items[..6].join(", "), items.len() - 6),
    }
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

pub fn num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        let s = format!("{n:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn money(n: f64) -> String {
    let whole = n.round() as i64;
    let digits = whole.abs().to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if whole < 0 { format!("-{out}") } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strategy::parse;

    #[test]
    fn describes_a_mean_reversion_strategy() {
        let s = parse(serde_json::json!({
            "name": "Oversold tech",
            "universe": { "symbols": ["AAPL", "MSFT"] },
            "rules": [
                { "when": { "all": [
                    { "lt": [{ "rsi": { "period": 14 } }, 30] },
                    { "gt": [{ "price": {} }, { "sma": { "period": 200 } }] }
                ]}, "then": { "buy": { "percent_of_portfolio": 10 } } },
                { "when": { "gt": [{ "rsi": { "period": 14 } }, 70] }, "then": { "sell": {} } }
            ],
            "risk": { "stop_loss_pct": 8 }
        }))
        .unwrap();
        assert_eq!(
            describe(&s),
            vec![
                "Trades AAPL and MSFT.",
                "Buy 10% of the portfolio when RSI(14) < 30 and price > SMA(200).",
                "Sell the position when RSI(14) > 70.",
                "Sells any position that falls 8% below its entry.",
            ]
        );
    }

    #[test]
    fn describes_a_rotation_strategy() {
        let s = parse(serde_json::json!({
            "name": "Momentum",
            "universe": { "symbols": ["SPY", "QQQ", "TLT", "GLD"] },
            "rules": [{
                "when": { "all": [
                    { "schedule": "monthly" },
                    { "gt": [{ "price": { "symbol": "SPY" } }, { "sma": { "period": 200, "symbol": "SPY" } }] }
                ]},
                "then": { "rebalance": { "top": 2, "by": { "return": { "period": 90 } } } }
            }]
        }))
        .unwrap();
        assert_eq!(
            describe(&s)[1],
            "At the start of each month and SPY price > SPY SMA(200), hold the 2 symbols with the highest 90-day return % at equal weight."
        );
    }
}
