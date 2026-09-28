//! Kestrel's engine: the strategy format, indicators, and a backtester whose rule evaluation is
//! shared with paper trading.

pub mod backtest;
pub mod bar;
pub mod english;
pub mod eval;
pub mod indicators;
pub mod metrics;
pub mod optimize;
pub mod strategy;
pub mod validate;

pub use backtest::{BacktestConfig, BacktestResult};
pub use bar::Bar;
pub use eval::Market;
pub use strategy::Strategy;
