use serde::{Deserialize, Serialize};

/// One daily bar. `t` is midnight UTC of the trading date, in seconds, so bars from different
/// venues line up by date.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bar {
    pub t: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
}

pub const DAY: i64 = 86_400;

/// Crypto pairs are written with a slash, like `BTC/USD`.
pub fn is_crypto(symbol: &str) -> bool {
    symbol.contains('/')
}
