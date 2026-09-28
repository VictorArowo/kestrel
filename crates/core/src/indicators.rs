//! Indicator series. Every function is causal: output `i` depends only on inputs `0..=i`, and is
//! NaN until there is enough history.

use crate::bar::Bar;

pub fn sma(x: &[f64], period: usize) -> Vec<f64> {
    let mut out = vec![f64::NAN; x.len()];
    if period == 0 {
        return out;
    }
    let mut sum = 0.0;
    let mut count = 0usize;
    for i in 0..x.len() {
        if x[i].is_nan() {
            sum = 0.0;
            count = 0;
            continue;
        }
        sum += x[i];
        count += 1;
        if count > period {
            sum -= x[i - period];
            count = period;
        }
        if count == period {
            out[i] = sum / period as f64;
        }
    }
    out
}

/// Exponential moving average seeded with the simple average of the first `period` values.
/// Leading NaNs (from an input that is itself an indicator) are skipped.
pub fn ema(x: &[f64], period: usize) -> Vec<f64> {
    let mut out = vec![f64::NAN; x.len()];
    if period == 0 {
        return out;
    }
    let Some(start) = x.iter().position(|v| !v.is_nan()) else {
        return out;
    };
    let seed_end = start + period - 1;
    if seed_end >= x.len() {
        return out;
    }
    let alpha = 2.0 / (period as f64 + 1.0);
    let mut prev = x[start..=seed_end].iter().sum::<f64>() / period as f64;
    out[seed_end] = prev;
    for i in seed_end + 1..x.len() {
        prev = alpha * x[i] + (1.0 - alpha) * prev;
        out[i] = prev;
    }
    out
}

/// Wilder's RSI.
pub fn rsi(close: &[f64], period: usize) -> Vec<f64> {
    let mut out = vec![f64::NAN; close.len()];
    if period == 0 || close.len() <= period {
        return out;
    }
    let (mut gain, mut loss) = (0.0, 0.0);
    for i in 1..=period {
        let d = close[i] - close[i - 1];
        if d > 0.0 { gain += d } else { loss -= d }
    }
    gain /= period as f64;
    loss /= period as f64;
    out[period] = rsi_value(gain, loss);
    for i in period + 1..close.len() {
        let d = close[i] - close[i - 1];
        let (g, l) = if d > 0.0 { (d, 0.0) } else { (0.0, -d) };
        gain = (gain * (period - 1) as f64 + g) / period as f64;
        loss = (loss * (period - 1) as f64 + l) / period as f64;
        out[i] = rsi_value(gain, loss);
    }
    out
}

fn rsi_value(gain: f64, loss: f64) -> f64 {
    if loss == 0.0 {
        if gain == 0.0 { 50.0 } else { 100.0 }
    } else {
        100.0 - 100.0 / (1.0 + gain / loss)
    }
}

/// Wilder's average true range.
pub fn atr(bars: &[Bar], period: usize) -> Vec<f64> {
    let mut out = vec![f64::NAN; bars.len()];
    if period == 0 || bars.len() < period {
        return out;
    }
    let tr: Vec<f64> = bars
        .iter()
        .enumerate()
        .map(|(i, b)| {
            if i == 0 {
                b.h - b.l
            } else {
                let pc = bars[i - 1].c;
                (b.h - b.l).max((b.h - pc).abs()).max((b.l - pc).abs())
            }
        })
        .collect();
    let mut prev = tr[..period].iter().sum::<f64>() / period as f64;
    out[period - 1] = prev;
    for i in period..bars.len() {
        prev = (prev * (period - 1) as f64 + tr[i]) / period as f64;
        out[i] = prev;
    }
    out
}

/// Percent change over `period` bars.
pub fn pct_return(close: &[f64], period: usize) -> Vec<f64> {
    (0..close.len())
        .map(|i| {
            if i >= period && period > 0 {
                (close[i] / close[i - period] - 1.0) * 100.0
            } else {
                f64::NAN
            }
        })
        .collect()
}

pub fn rolling_max(x: &[f64], period: usize) -> Vec<f64> {
    rolling(x, period, |w| {
        w.iter().copied().fold(f64::NEG_INFINITY, f64::max)
    })
}

pub fn rolling_min(x: &[f64], period: usize) -> Vec<f64> {
    rolling(x, period, |w| {
        w.iter().copied().fold(f64::INFINITY, f64::min)
    })
}

/// Population standard deviation over the window.
pub fn rolling_std(x: &[f64], period: usize) -> Vec<f64> {
    rolling(x, period, |w| {
        let mean = w.iter().sum::<f64>() / w.len() as f64;
        (w.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / w.len() as f64).sqrt()
    })
}

/// Standard deviation of daily percent returns over the window.
pub fn volatility(close: &[f64], period: usize) -> Vec<f64> {
    let returns = pct_return(close, 1);
    rolling_std(&returns, period)
}

pub struct MacdSeries {
    pub macd: Vec<f64>,
    pub signal: Vec<f64>,
    pub histogram: Vec<f64>,
}

pub fn macd(close: &[f64], fast: usize, slow: usize, signal: usize) -> MacdSeries {
    let (f, s) = (ema(close, fast), ema(close, slow));
    let macd: Vec<f64> = f.iter().zip(&s).map(|(a, b)| a - b).collect();
    let signal = ema(&macd, signal);
    let histogram = macd.iter().zip(&signal).map(|(a, b)| a - b).collect();
    MacdSeries {
        macd,
        signal,
        histogram,
    }
}

fn rolling(x: &[f64], period: usize, f: impl Fn(&[f64]) -> f64) -> Vec<f64> {
    (0..x.len())
        .map(|i| {
            if period == 0 || i + 1 < period {
                return f64::NAN;
            }
            let w = &x[i + 1 - period..=i];
            if w.iter().any(|v| v.is_nan()) {
                f64::NAN
            } else {
                f(w)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close_enough(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn sma_waits_for_a_full_window() {
        let out = sma(&[1.0, 2.0, 3.0, 4.0], 3);
        assert!(out[1].is_nan());
        assert!(close_enough(out[2], 2.0));
        assert!(close_enough(out[3], 3.0));
    }

    #[test]
    fn ema_seeds_with_the_simple_average() {
        let out = ema(&[1.0, 2.0, 3.0, 4.0], 3);
        assert!(close_enough(out[2], 2.0));
        assert!(close_enough(out[3], 0.5 * 4.0 + 0.5 * 2.0));
    }

    #[test]
    fn rsi_is_100_when_price_only_rises() {
        let close: Vec<f64> = (0..20).map(|i| i as f64).collect();
        assert!(close_enough(rsi(&close, 14)[19], 100.0));
    }

    #[test]
    fn rsi_matches_a_reference_value() {
        // Wilder's example series.
        let close = [
            44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03,
            45.61, 46.28, 46.28,
        ];
        assert!((rsi(&close, 14)[14] - 70.46).abs() < 0.1);
    }

    #[test]
    fn indicators_are_causal() {
        let close: Vec<f64> = (0..60)
            .map(|i| 100.0 + (i as f64 * 0.7).sin() * 5.0)
            .collect();
        let full = rsi(&close, 14);
        let prefix = rsi(&close[..40], 14);
        for i in 0..40 {
            assert!(full[i].is_nan() && prefix[i].is_nan() || close_enough(full[i], prefix[i]));
        }
    }
}
