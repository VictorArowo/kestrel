//! The engine's HTTP API. It is stateless: the web app owns users, strategies and portfolios and
//! calls this for anything that needs market data or computation.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{Duration, NaiveDate, Utc};
use kestrel_core::backtest::{self, BacktestConfig};
use kestrel_core::optimize::{self, OptimizeSpec};
use kestrel_core::strategy::{self, Strategy};
use kestrel_core::validate::{self, Issue, Severity};
use kestrel_core::{english, indicators as ind};
use kestrel_data::{DataClient, Kind, day_start};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::market;

#[derive(Clone)]
pub struct AppState {
    pub data: Arc<DataClient>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/v1/symbols", get(symbols))
        .route("/v1/snapshot", get(snapshot))
        .route("/v1/bars", get(bars))
        .route("/v1/validate", post(validate_strategy))
        .route("/v1/backtest", post(run_backtest))
        .route("/v1/optimize", post(run_optimize))
        .with_state(state)
}

pub struct ApiError {
    status: StatusCode,
    body: Value,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::BAD_REQUEST,
            body: json!({ "error": message.into() }),
        }
    }

    fn invalid(issues: Vec<Issue>) -> Self {
        ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            body: json!({ "error": "the strategy has errors", "issues": issues }),
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError {
            status: StatusCode::BAD_GATEWAY,
            body: json!({ "error": format!("{e:#}") }),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

fn parse_strategy(v: Value) -> Result<(Strategy, Vec<Issue>), ApiError> {
    let s = strategy::parse(v).map_err(|e| {
        ApiError::invalid(vec![Issue {
            path: e.path,
            message: e.message,
            severity: Severity::Error,
        }])
    })?;
    let issues = validate::validate(&s);
    if validate::has_errors(&issues) {
        return Err(ApiError::invalid(issues));
    }
    Ok((s, issues))
}

fn parse_date(s: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| ApiError::bad_request(format!("`{s}` isn't a YYYY-MM-DD date")))
}

fn yesterday() -> NaiveDate {
    Utc::now().date_naive() - Duration::days(1)
}

fn period(start: &str, end: Option<&str>) -> Result<(NaiveDate, NaiveDate), ApiError> {
    let start = parse_date(start)?;
    let end = end
        .map(parse_date)
        .transpose()?
        .unwrap_or_else(yesterday)
        .min(yesterday());
    if start >= end {
        return Err(ApiError::bad_request("start must be before end"));
    }
    if end - start < Duration::days(30) {
        return Err(ApiError::bad_request("use a period of at least a month"));
    }
    Ok((start, end))
}

#[derive(Deserialize)]
struct SymbolsQuery {
    #[serde(default)]
    q: String,
    kind: Option<String>,
    limit: Option<usize>,
}

async fn symbols(Query(q): Query<SymbolsQuery>) -> ApiResult<Value> {
    let kind = match q.kind.as_deref() {
        Some("stock") => Some(Kind::Stock),
        Some("etf") => Some(Kind::Etf),
        Some("crypto") => Some(Kind::Crypto),
        _ => None,
    };
    let hits: Vec<_> = kestrel_data::search(&q.q, kind)
        .into_iter()
        .take(q.limit.unwrap_or(25))
        .collect();
    Ok(Json(json!({ "symbols": hits })))
}

#[derive(Deserialize)]
struct SymbolQuery {
    symbol: String,
    start: Option<String>,
    end: Option<String>,
}

async fn bars(State(st): State<AppState>, Query(q): Query<SymbolQuery>) -> ApiResult<Value> {
    let end = q
        .end
        .as_deref()
        .map(parse_date)
        .transpose()?
        .unwrap_or_else(yesterday);
    let start = q
        .start
        .as_deref()
        .map(parse_date)
        .transpose()?
        .unwrap_or(end - Duration::days(365));
    let bars = st.data.daily_bars(&q.symbol, start, end).await?;
    Ok(Json(json!({ "symbol": q.symbol, "bars": bars })))
}

/// A quick read on one symbol, so the agent can ground its ideas in current conditions.
async fn snapshot(State(st): State<AppState>, Query(q): Query<SymbolQuery>) -> ApiResult<Value> {
    let end = yesterday();
    let bars = st
        .data
        .daily_bars(&q.symbol, end - Duration::days(420), end)
        .await?;
    let Some(last) = bars.last() else {
        return Err(ApiError::bad_request(format!(
            "no recent data for {}",
            q.symbol
        )));
    };
    let close: Vec<f64> = bars.iter().map(|b| b.c).collect();
    let n = close.len();
    let at = |v: Vec<f64>| v.last().copied().filter(|x| x.is_finite());
    // Trading days per period differ between stocks and crypto, so look back by calendar date.
    let ret_since = |days: i64| {
        let t = last.t - days * 86_400;
        let i = bars.partition_point(|b| b.t <= t).checked_sub(1)?;
        Some((last.c / bars[i].c - 1.0) * 100.0)
    };
    let year: Vec<f64> = bars
        .iter()
        .filter(|b| b.t > last.t - 365 * 86_400)
        .map(|b| b.c)
        .collect();
    let info = kestrel_data::lookup(&q.symbol);
    Ok(Json(json!({
        "symbol": q.symbol,
        "name": info.map(|i| i.name.clone()),
        "sector": info.map(|i| i.sector.clone()),
        "date": kestrel_data::date_of(last.t).to_string(),
        "close": last.c,
        "return_1m_pct": ret_since(30),
        "return_3m_pct": ret_since(91),
        "return_6m_pct": ret_since(182),
        "return_1y_pct": ret_since(365),
        "sma_50": at(ind::sma(&close, 50)),
        "sma_200": at(ind::sma(&close, 200)),
        "rsi_14": at(ind::rsi(&close, 14)),
        "volatility_20d_pct": at(ind::volatility(&close, 20)),
        "high_52w": year.iter().copied().fold(f64::NAN, f64::max),
        "low_52w": year.iter().copied().fold(f64::NAN, f64::min),
        "bars": n,
    })))
}

#[derive(Deserialize)]
struct ValidateRequest {
    strategy: Value,
}

#[derive(Serialize)]
struct ValidateResponse {
    ok: bool,
    issues: Vec<Issue>,
    description: Vec<String>,
    strategy: Option<Strategy>,
    symbols: Vec<String>,
}

async fn validate_strategy(Json(req): Json<ValidateRequest>) -> ApiResult<ValidateResponse> {
    let s = match strategy::parse(req.strategy) {
        Ok(s) => s,
        Err(e) => {
            return Ok(Json(ValidateResponse {
                ok: false,
                issues: vec![Issue {
                    path: e.path,
                    message: e.message,
                    severity: Severity::Error,
                }],
                description: vec![],
                strategy: None,
                symbols: vec![],
            }));
        }
    };
    let issues = validate::validate(&s);
    Ok(Json(ValidateResponse {
        ok: !validate::has_errors(&issues),
        issues,
        description: english::describe(&s),
        symbols: s.symbols(),
        strategy: Some(s),
    }))
}

#[derive(Deserialize)]
struct BacktestRequest {
    strategy: Value,
    start: String,
    end: Option<String>,
    initial_cash: Option<f64>,
    slippage_bps: Option<f64>,
    benchmark: Option<String>,
}

impl BacktestRequest {
    fn config(&self, start: NaiveDate, end: NaiveDate) -> BacktestConfig {
        let mut cfg = BacktestConfig::new(day_start(start), day_start(end));
        if let Some(c) = self.initial_cash {
            cfg.initial_cash = c;
        }
        if let Some(s) = self.slippage_bps {
            cfg.slippage_bps = s;
        }
        cfg.benchmark = self.benchmark.clone();
        cfg
    }
}

async fn run_backtest(
    State(st): State<AppState>,
    Json(req): Json<BacktestRequest>,
) -> ApiResult<Value> {
    let (s, issues) = parse_strategy(req.strategy.clone())?;
    let (start, end) = period(&req.start, req.end.as_deref())?;
    let cfg = req.config(start, end);
    let market = market::for_strategy(&st.data, &s, &cfg.benchmark_for(&s), start, end, 0).await?;
    let description = english::describe(&s);
    let result = tokio::task::spawn_blocking(move || backtest::run(&s, &market, &cfg))
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?
        .map_err(ApiError::bad_request)?;
    Ok(Json(
        json!({ "description": description, "warnings": issues, "result": result }),
    ))
}

#[derive(Deserialize)]
struct OptimizeRequest {
    #[serde(flatten)]
    backtest: BacktestRequest,
    #[serde(flatten)]
    spec: OptimizeSpec,
}

async fn run_optimize(
    State(st): State<AppState>,
    Json(req): Json<OptimizeRequest>,
) -> ApiResult<Value> {
    let (s, _) = parse_strategy(req.backtest.strategy.clone())?;
    let (start, end) = period(&req.backtest.start, req.backtest.end.as_deref())?;
    let cfg = req.backtest.config(start, end);
    // Varying a period can lengthen the warm-up, so load enough for the largest value tried.
    let widest = req
        .spec
        .params
        .iter()
        .flat_map(|p| p.values.iter().filter_map(Value::as_u64))
        .max()
        .unwrap_or(0) as usize
        * 3;
    let market =
        market::for_strategy(&st.data, &s, &cfg.benchmark_for(&s), start, end, widest).await?;
    let spec = req.spec;
    let result = tokio::task::spawn_blocking(move || optimize::optimize(&s, &market, &cfg, &spec))
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::to_value(result).expect("serialisable")))
}
