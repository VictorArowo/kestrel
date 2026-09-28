//! Serves the engine's HTTP API from a Vercel function. Every path is rewritten here
//! (see vercel.json), and the axum router handles routing as it does locally.

use std::sync::Arc;

use kestrel_data::DataClient;
use kestrel_server::api::{AppState, router};
use tower::ServiceBuilder;
use vercel_runtime::Error;
use vercel_runtime::axum::VercelLayer;

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    // /tmp is the only writable place, and it survives between requests on a warm instance.
    let cache = std::env::var("KESTREL_CACHE_DIR").unwrap_or_else(|_| "/tmp/kestrel-cache".into());
    let data = Arc::new(DataClient::from_env(cache));
    let app = ServiceBuilder::new().layer(VercelLayer::new()).service(router(AppState { data }));
    vercel_runtime::run(app).await
}
