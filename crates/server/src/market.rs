//! Loading the bars a strategy needs, including enough history before the start date for its
//! indicators to warm up.

use std::collections::HashMap;

use anyhow::Result;
use chrono::{Duration, NaiveDate};
use futures::{StreamExt, TryStreamExt};
use kestrel_core::{Market, Strategy};
use kestrel_data::DataClient;

pub async fn load(
    data: &DataClient,
    symbols: &[String],
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Market> {
    let bars: HashMap<_, _> = futures::stream::iter(symbols.iter().cloned())
        .map(|sym| async move {
            let bars = data.daily_bars(&sym, start, end).await?;
            if bars.is_empty() {
                anyhow::bail!("no data for {sym} between {start} and {end}; check the symbol");
            }
            Ok((sym, bars))
        })
        .buffer_unordered(6)
        .try_collect()
        .await?;
    Ok(Market::new(bars))
}

/// Calendar days to fetch for `bars` trading days of history. Stocks trade about 252 days a
/// year, so each bar needs roughly 1.45 calendar days.
pub fn warmup_days(bars: usize) -> i64 {
    (bars as f64 * 1.5) as i64 + 10
}

pub async fn for_strategy(
    data: &DataClient,
    s: &Strategy,
    benchmark: &str,
    start: NaiveDate,
    end: NaiveDate,
    min_lookback: usize,
) -> Result<Market> {
    let mut symbols = s.symbols();
    if !symbols.iter().any(|x| x == benchmark) {
        symbols.push(benchmark.to_string());
    }
    let warmup = warmup_days(s.lookback().max(min_lookback));
    load(data, &symbols, start - Duration::days(warmup), end).await
}
