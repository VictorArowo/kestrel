//! Market data: daily bars from Alpaca's market data API, cached as JSON per symbol, and a small
//! catalog of well-known symbols for search.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use kestrel_core::bar::{Bar, DAY, is_crypto};
use serde::{Deserialize, Serialize};

mod catalog;
pub use catalog::{Kind, SymbolInfo, lookup, search};

const DATA_URL: &str = "https://data.alpaca.markets";

#[derive(Clone)]
pub struct DataClient {
    http: reqwest::Client,
    keys: Option<(String, String)>,
    feed: String,
    cache_dir: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    from: NaiveDate,
    to: NaiveDate,
    bars: Vec<Bar>,
}

impl DataClient {
    /// Reads `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY` and optionally `APCA_DATA_FEED`. The
    /// default is `sip` (every US exchange): free accounts can read it for anything older than 15
    /// minutes, and it goes back to 2016, where `iex` only starts in mid-2020. Crypto works
    /// without keys; stocks don't.
    pub fn from_env(cache_dir: impl Into<PathBuf>) -> Self {
        let key = std::env::var("APCA_API_KEY_ID")
            .ok()
            .filter(|s| !s.is_empty());
        let secret = std::env::var("APCA_API_SECRET_KEY")
            .ok()
            .filter(|s| !s.is_empty());
        DataClient {
            http: reqwest::Client::builder()
                .user_agent("kestrel/0.1")
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("http client"),
            keys: key.zip(secret),
            feed: std::env::var("APCA_DATA_FEED").unwrap_or_else(|_| "sip".into()),
            cache_dir: cache_dir.into(),
        }
    }

    pub fn has_keys(&self) -> bool {
        self.keys.is_some()
    }

    /// Completed daily bars dated `start..=end`. Bars from before today are cached; today's bar
    /// is never returned because it hasn't closed.
    pub async fn daily_bars(
        &self,
        symbol: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Bar>> {
        let yesterday = Utc::now().date_naive() - Duration::days(1);
        let end = end.min(yesterday);
        if start > end {
            return Ok(vec![]);
        }
        let path = self.cache_path(symbol);
        let cached = read_cache(&path).await;
        let file = match cached {
            Some(c) if c.from <= start && c.to >= end => c,
            other => {
                let (from, to) = match &other {
                    Some(c) => (c.from.min(start), c.to.max(end)),
                    None => (start, end),
                };
                let bars = self.fetch(symbol, from, to).await?;
                let file = CacheFile { from, to, bars };
                write_cache(&path, &file).await;
                file
            }
        };
        let (lo, hi) = (day_start(start), day_start(end));
        Ok(file
            .bars
            .into_iter()
            .filter(|b| b.t >= lo && b.t <= hi)
            .collect())
    }

    /// Bars straight from the API, bypassing the cache. Used by paper trading, which needs
    /// the bar that just closed.
    pub async fn fresh_bars(&self, symbol: &str, start: NaiveDate) -> Result<Vec<Bar>> {
        self.fetch(symbol, start, Utc::now().date_naive()).await
    }

    async fn fetch(&self, symbol: &str, start: NaiveDate, end: NaiveDate) -> Result<Vec<Bar>> {
        let crypto = is_crypto(symbol);
        if !crypto && self.keys.is_none() {
            bail!(
                "stock data needs Alpaca API keys: set APCA_API_KEY_ID and APCA_API_SECRET_KEY in .env"
            );
        }
        let url = if crypto {
            format!("{DATA_URL}/v1beta3/crypto/us/bars")
        } else {
            format!("{DATA_URL}/v2/stocks/bars")
        };
        let start_s = format!("{start}T00:00:00Z");
        let end_s = format!("{end}T23:59:59Z");
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut query: Vec<(&str, &str)> = vec![
                ("symbols", symbol),
                ("timeframe", "1Day"),
                ("start", &start_s),
                ("end", &end_s),
                ("limit", "10000"),
            ];
            if !crypto {
                query.push(("adjustment", "all"));
                query.push(("feed", &self.feed));
            }
            if let Some(p) = &page {
                query.push(("page_token", p));
            }
            let mut req = self.http.get(&url).query(&query);
            if let Some((key, secret)) = &self.keys {
                req = req
                    .header("APCA-API-KEY-ID", key)
                    .header("APCA-API-SECRET-KEY", secret);
            }
            let resp = req
                .send()
                .await
                .with_context(|| format!("fetching {symbol}"))?;
            let status = resp.status();
            if status == reqwest::StatusCode::FORBIDDEN && !crypto && self.feed != "iex" {
                tracing::warn!(symbol, feed = %self.feed, "feed refused, falling back to iex");
                let fallback = DataClient { feed: "iex".into(), ..self.clone() };
                return Box::pin(fallback.fetch(symbol, start, end)).await;
            }
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(anyhow!(
                    "Alpaca returned {status} for {symbol}: {}",
                    body.trim()
                ));
            }
            let body: BarsResponse = resp
                .json()
                .await
                .with_context(|| format!("decoding bars for {symbol}"))?;
            for b in body.bars.into_values().flatten() {
                let t = DateTime::parse_from_rfc3339(&b.t)
                    .with_context(|| format!("bad timestamp {}", b.t))?;
                out.push(Bar {
                    t: t.timestamp().div_euclid(DAY) * DAY,
                    o: b.o,
                    h: b.h,
                    l: b.l,
                    c: b.c,
                    v: b.v,
                });
            }
            match body.next_page_token {
                Some(p) if !p.is_empty() => page = Some(p),
                _ => break,
            }
        }
        out.sort_by_key(|b| b.t);
        out.dedup_by_key(|b| b.t);
        if crypto {
            out = drop_before_relisting(out);
        }
        tracing::debug!(symbol, bars = out.len(), %start, %end, "fetched bars");
        Ok(out)
    }

    fn cache_path(&self, symbol: &str) -> PathBuf {
        self.cache_dir
            .join(format!("{}.json", symbol.replace('/', "-")))
    }
}

#[derive(Deserialize)]
struct BarsResponse {
    #[serde(default)]
    bars: std::collections::HashMap<String, Vec<RawBar>>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct RawBar {
    t: String,
    o: f64,
    h: f64,
    l: f64,
    c: f64,
    v: f64,
}

/// Crypto trades every day, so a gap of more than a week means the pair was delisted and later
/// relisted (Alpaca's SOL/USD is missing from mid-2023 to August 2024). Prices on either side of
/// the gap aren't continuous, and the first bar back opens at a stale price, so keep only the
/// history after the last gap, starting from its second bar.
fn drop_before_relisting(bars: Vec<Bar>) -> Vec<Bar> {
    match bars.windows(2).rposition(|w| w[1].t - w[0].t > 7 * DAY) {
        Some(i) => bars.into_iter().skip(i + 2).collect(),
        None => bars,
    }
}

pub fn day_start(d: NaiveDate) -> i64 {
    d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp()
}

pub fn date_of(t: i64) -> NaiveDate {
    DateTime::from_timestamp(t, 0)
        .expect("valid timestamp")
        .date_naive()
}

async fn read_cache(path: &Path) -> Option<CacheFile> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn write_cache(path: &Path, file: &CacheFile) {
    if let Some(dir) = path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    let tmp = path.with_extension("json.tmp");
    let Ok(bytes) = serde_json::to_vec(file) else {
        return;
    };
    if tokio::fs::write(&tmp, bytes).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, path).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(day: i64, o: f64, c: f64) -> Bar {
        Bar {
            t: day * DAY,
            o,
            h: o.max(c),
            l: o.min(c),
            c,
            v: 1.0,
        }
    }

    #[test]
    fn crypto_history_restarts_after_a_relisting() {
        let bars = vec![
            bar(0, 10.0, 11.0),
            bar(1, 11.0, 12.0),
            bar(400, 12.0, 150.0),
            bar(401, 150.0, 148.0),
        ];
        let kept = drop_before_relisting(bars);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].t, 401 * DAY);
    }

    #[test]
    fn continuous_history_is_untouched() {
        let bars: Vec<Bar> = (0..10).map(|d| bar(d, 1.0, 1.0)).collect();
        assert_eq!(drop_before_relisting(bars).len(), 10);
    }
}
