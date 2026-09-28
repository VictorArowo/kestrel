//! Performance statistics from an equity curve and its closed trades.

use serde::Serialize;

use crate::backtest::{Point, Trade};
use crate::bar::DAY;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Metrics {
    pub total_return_pct: f64,
    pub cagr_pct: f64,
    /// Annualised, zero risk-free rate.
    pub sharpe: f64,
    pub sortino: f64,
    /// Negative, e.g. -12.5.
    pub max_drawdown_pct: f64,
    /// Annualised standard deviation of returns.
    pub volatility_pct: f64,
    /// CAGR over the size of the max drawdown.
    pub calmar: f64,
    pub trades: usize,
    pub win_rate_pct: Option<f64>,
    pub avg_trade_pct: Option<f64>,
    pub profit_factor: Option<f64>,
    /// Share of bars with any position open.
    pub exposure_pct: f64,
}

pub fn compute(equity: &[Point], trades: &[Trade], exposure: f64) -> Metrics {
    let mut m = Metrics {
        trades: trades.len(),
        exposure_pct: exposure * 100.0,
        ..Default::default()
    };
    if equity.len() < 2 || equity[0].v <= 0.0 {
        return m;
    }
    let (first, last) = (equity[0], equity[equity.len() - 1]);
    let years = (last.t - first.t) as f64 / (365.25 * DAY as f64);
    let per_year = if years > 0.05 {
        (equity.len() - 1) as f64 / years
    } else {
        252.0
    };

    m.total_return_pct = (last.v / first.v - 1.0) * 100.0;
    if years > 0.0 && last.v > 0.0 {
        m.cagr_pct = ((last.v / first.v).powf(1.0 / years) - 1.0) * 100.0;
    }

    let returns: Vec<f64> = equity.windows(2).map(|w| w[1].v / w[0].v - 1.0).collect();
    let n = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / n;
    let sd = if n > 1.0 {
        (returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
    } else {
        0.0
    };
    let downside = (returns.iter().map(|r| r.min(0.0).powi(2)).sum::<f64>() / n).sqrt();
    m.volatility_pct = sd * per_year.sqrt() * 100.0;
    m.sharpe = if sd > 0.0 {
        mean / sd * per_year.sqrt()
    } else {
        0.0
    };
    m.sortino = if downside > 0.0 {
        mean / downside * per_year.sqrt()
    } else {
        0.0
    };

    let mut peak = f64::MIN;
    let mut worst = 0.0f64;
    for p in equity {
        peak = peak.max(p.v);
        worst = worst.min(p.v / peak - 1.0);
    }
    m.max_drawdown_pct = worst * 100.0;
    m.calmar = if worst < 0.0 {
        m.cagr_pct / -m.max_drawdown_pct
    } else {
        0.0
    };

    if !trades.is_empty() {
        let wins = trades.iter().filter(|t| t.pnl > 0.0).count();
        m.win_rate_pct = Some(wins as f64 / trades.len() as f64 * 100.0);
        m.avg_trade_pct =
            Some(trades.iter().map(|t| t.return_pct).sum::<f64>() / trades.len() as f64);
        let gains: f64 = trades.iter().filter(|t| t.pnl > 0.0).map(|t| t.pnl).sum();
        let losses: f64 = -trades
            .iter()
            .filter(|t| t.pnl < 0.0)
            .map(|t| t.pnl)
            .sum::<f64>();
        m.profit_factor = (losses > 0.0).then(|| gains / losses);
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drawdown_and_return() {
        let eq: Vec<Point> = [100.0, 120.0, 90.0, 110.0]
            .iter()
            .enumerate()
            .map(|(i, v)| Point {
                t: i as i64 * DAY,
                v: *v,
            })
            .collect();
        let m = compute(&eq, &[], 1.0);
        assert!((m.total_return_pct - 10.0).abs() < 1e-9);
        assert!((m.max_drawdown_pct + 25.0).abs() < 1e-9);
    }
}
