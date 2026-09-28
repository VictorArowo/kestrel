use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::NaiveDate;
use clap::{Parser, Subcommand};
use kestrel_core::backtest::{self, BacktestConfig};
use kestrel_core::{english, strategy, validate};
use kestrel_data::{DataClient, day_start};
use kestrel_server::{api, market};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[derive(Parser)]
#[command(name = "kestrel", about = "Kestrel's trading engine")]
struct Cli {
    /// Where downloaded bars are cached.
    #[arg(
        long,
        env = "KESTREL_CACHE_DIR",
        default_value = "data/cache",
        global = true
    )]
    cache_dir: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP API.
    Serve {
        #[arg(long, env = "KESTREL_ENGINE_PORT", default_value_t = 7070)]
        port: u16,
    },
    /// Backtest a strategy file and print a summary.
    Backtest {
        file: PathBuf,
        #[arg(long)]
        start: NaiveDate,
        #[arg(long)]
        end: Option<NaiveDate>,
        /// Print the full result as JSON instead of a summary.
        #[arg(long)]
        json: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "kestrel=info,kestrel_data=info,tower_http=info".into()),
        )
        .init();
    let cli = Cli::parse();
    let data = Arc::new(DataClient::from_env(&cli.cache_dir));

    match cli.command {
        Command::Serve { port } => {
            if !data.has_keys() {
                tracing::warn!("no Alpaca keys set: crypto works, stocks will fail");
            }
            let app = api::router(api::AppState { data })
                .layer(CorsLayer::permissive())
                .layer(TraceLayer::new_for_http());
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
            tracing::info!("engine listening on http://127.0.0.1:{port}");
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown())
                .await?;
        }
        Command::Backtest {
            file,
            start,
            end,
            json,
        } => {
            let text = std::fs::read_to_string(&file)
                .with_context(|| format!("reading {}", file.display()))?;
            let s = strategy::parse(serde_json::from_str(&text)?)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let issues = validate::validate(&s);
            for i in &issues {
                eprintln!("{:?} {}: {}", i.severity, i.path, i.message);
            }
            anyhow::ensure!(!validate::has_errors(&issues), "the strategy has errors");
            let end =
                end.unwrap_or_else(|| chrono::Utc::now().date_naive() - chrono::Duration::days(1));
            let cfg = BacktestConfig::new(day_start(start), day_start(end));
            let market =
                market::for_strategy(&data, &s, &cfg.benchmark_for(&s), start, end, 0).await?;
            let r = backtest::run(&s, &market, &cfg).map_err(anyhow::Error::msg)?;
            if json {
                println!("{}", serde_json::to_string(&r)?);
                return Ok(());
            }
            for line in english::describe(&s) {
                println!("  {line}");
            }
            let m = &r.metrics;
            println!();
            println!("  {start} → {end}");
            println!(
                "  return   {:>8.1}%   cagr    {:>6.1}%",
                m.total_return_pct, m.cagr_pct
            );
            println!(
                "  sharpe   {:>8.2}    max dd  {:>6.1}%",
                m.sharpe, m.max_drawdown_pct
            );
            println!(
                "  trades   {:>8}    win     {:>6.1}%",
                m.trades,
                m.win_rate_pct.unwrap_or(0.0)
            );
            if let Some(b) = &r.benchmark {
                println!(
                    "  {} {:>8.1}%   sharpe  {:>6.2}",
                    b.symbol, b.metrics.total_return_pct, b.metrics.sharpe
                );
            }
            for w in &r.warnings {
                println!("  warning: {w}");
            }
        }
    }
    Ok(())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
