use std::collections::HashMap;

use kestrel_core::backtest::{self, BacktestConfig, Side};
use kestrel_core::bar::{Bar, DAY};
use kestrel_core::strategy::parse;
use kestrel_core::{Market, Strategy};
use serde_json::json;

const T0: i64 = 1_704_067_200; // 2024-01-01

fn bars(closes: &[f64]) -> Vec<Bar> {
    closes
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            // Open halfway between the previous close and this one.
            let o = if i == 0 { c } else { (closes[i - 1] + c) / 2.0 };
            Bar {
                t: T0 + i as i64 * DAY,
                o,
                h: o.max(c) + 1.0,
                l: o.min(c) - 1.0,
                c,
                v: 1000.0,
            }
        })
        .collect()
}

fn market(series: &[(&str, Vec<f64>)]) -> Market {
    Market::new(
        series
            .iter()
            .map(|(s, c)| (s.to_string(), bars(c)))
            .collect::<HashMap<_, _>>(),
    )
}

fn strategy(v: serde_json::Value) -> Strategy {
    parse(v).unwrap()
}

fn config(days: i64) -> BacktestConfig {
    BacktestConfig {
        benchmark: Some("AAA".into()),
        ..BacktestConfig::new(T0, T0 + (days - 1) * DAY)
    }
}

fn frictionless(days: i64) -> BacktestConfig {
    BacktestConfig {
        slippage_bps: 0.0,
        stock_fee_bps: 0.0,
        ..config(days)
    }
}

#[test]
fn decisions_fill_at_the_next_open_with_slippage() {
    let m = market(&[("AAA", vec![100.0, 101.0, 106.0, 108.0, 110.0])]);
    let s = strategy(json!({
        "name": "breakout",
        "universe": { "symbols": ["AAA"] },
        "rules": [{ "when": { "gt": [{ "price": {} }, 105] }, "then": { "buy": { "percent_of_portfolio": 50 } } }]
    }));
    let r = backtest::run(&s, &m, &config(5)).unwrap();
    let fill = &r.fills[0];
    // Close crossed 105 on day 2, so the order fills at day 3's open.
    assert_eq!(fill.t, T0 + 3 * DAY);
    assert_eq!(fill.side, Side::Buy);
    assert!((fill.price - 107.0 * 1.0005).abs() < 1e-9);
    assert!((fill.qty * fill.price - 50_000.0).abs() < 1.0);
}

#[test]
fn future_bars_do_not_change_past_decisions() {
    let past = vec![
        100.0, 98.0, 95.0, 97.0, 101.0, 104.0, 99.0, 96.0, 102.0, 107.0,
    ];
    let mut a = past.clone();
    a.extend([120.0, 130.0, 90.0, 85.0]);
    let mut b = past.clone();
    b.extend([60.0, 50.0, 140.0, 150.0]);
    let s = strategy(json!({
        "name": "mean reversion",
        "universe": { "symbols": ["AAA"] },
        "rules": [
            { "when": { "lt": [{ "price": {} }, { "sma": { "period": 3 } }] }, "then": { "buy": { "percent_of_cash": 90 } } },
            { "when": { "gt": [{ "price": {} }, { "sma": { "period": 3 } }] }, "then": { "sell": {} } }
        ]
    }));
    let cfg = config(14);
    let ra = backtest::run(&s, &market(&[("AAA", a)]), &cfg).unwrap();
    let rb = backtest::run(&s, &market(&[("AAA", b)]), &cfg).unwrap();
    let cutoff = T0 + (past.len() as i64) * DAY; // fills on this day are decided on the last shared bar
    let before = |fills: &[backtest::Fill]| {
        fills
            .iter()
            .filter(|f| f.t <= cutoff)
            .map(|f| (f.t, f.side, f.qty.to_bits()))
            .collect::<Vec<_>>()
    };
    assert!(!before(&ra.fills).is_empty());
    assert_eq!(before(&ra.fills), before(&rb.fills));
    let eq = |r: &backtest::BacktestResult| {
        r.equity
            .iter()
            .filter(|p| p.t < cutoff)
            .map(|p| p.v.to_bits())
            .collect::<Vec<_>>()
    };
    assert_eq!(eq(&ra), eq(&rb));
}

#[test]
fn runs_are_deterministic() {
    let closes: Vec<f64> = (0..300)
        .map(|i| 100.0 + (i as f64 * 0.3).sin() * 10.0 + i as f64 * 0.05)
        .collect();
    let m = market(&[("AAA", closes)]);
    let s = strategy(json!({
        "name": "rsi",
        "universe": { "symbols": ["AAA"] },
        "rules": [
            { "when": { "lt": [{ "rsi": { "period": 14 } }, 35] }, "then": { "buy": { "percent_of_portfolio": 100 } } },
            { "when": { "gt": [{ "rsi": { "period": 14 } }, 65] }, "then": { "sell": {} } }
        ]
    }));
    let a = serde_json::to_string(&backtest::run(&s, &m, &config(300)).unwrap()).unwrap();
    let b = serde_json::to_string(&backtest::run(&s, &m, &config(300)).unwrap()).unwrap();
    assert!(a.contains("\"side\":\"buy\""));
    assert_eq!(a, b);
}

#[test]
fn buy_and_hold_tracks_the_price() {
    let m = market(&[("AAA", vec![100.0, 100.0, 110.0, 120.0, 150.0])]);
    let s = strategy(json!({
        "name": "hold",
        "universe": { "symbols": ["AAA"] },
        "rules": [{ "when": { "schedule": "daily" }, "then": { "buy": { "percent_of_portfolio": 100 } } }]
    }));
    let r = backtest::run(&s, &m, &frictionless(5)).unwrap();
    // Bought at day 1's open (100), marked at the last close (150).
    assert!((r.final_equity - 150_000.0).abs() < 1e-6);
    assert_eq!(r.holdings.len(), 1);
    assert!(r.trades.is_empty());
}

#[test]
fn stop_loss_closes_the_position() {
    let m = market(&[("AAA", vec![100.0, 100.0, 95.0, 88.0, 85.0, 80.0])]);
    let s = strategy(json!({
        "name": "stopped",
        "universe": { "symbols": ["AAA"] },
        "rules": [{ "when": { "schedule": "monthly" }, "then": { "buy": { "percent_of_portfolio": 100 } } }],
        "risk": { "stop_loss_pct": 10 }
    }));
    let r = backtest::run(&s, &m, &frictionless(6)).unwrap();
    assert_eq!(r.trades.len(), 1);
    let t = &r.trades[0];
    assert_eq!(t.exit_reason, "stop loss");
    // Entry at 100; close of 88 is below the 10% stop, so it sells at the next open, (88 + 85) / 2.
    assert_eq!(t.exit_t, T0 + 4 * DAY);
    assert!((t.exit_price - 86.5).abs() < 1e-9);
}

#[test]
fn rebalance_holds_the_strongest() {
    let up: Vec<f64> = (0..40).map(|i| 100.0 + i as f64).collect();
    let flat = vec![100.0; 40];
    let down: Vec<f64> = (0..40).map(|i| 100.0 - i as f64 * 0.5).collect();
    let m = market(&[("AAA", flat), ("UPP", up), ("DWN", down)]);
    let s = strategy(json!({
        "name": "momentum",
        "universe": { "symbols": ["AAA", "UPP", "DWN"] },
        "rules": [{
            "when": { "schedule": "weekly" },
            "then": { "rebalance": { "top": 1, "by": { "return": { "period": 10 } } } }
        }]
    }));
    let r = backtest::run(&s, &m, &frictionless(40)).unwrap();
    assert!(r.fills.iter().all(|f| f.symbol == "UPP"), "{:?}", r.fills);
    assert_eq!(r.holdings.len(), 1);
    assert_eq!(r.holdings[0].symbol, "UPP");
}
