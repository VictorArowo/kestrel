use std::sync::OnceLock;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Stock,
    Etf,
    Crypto,
}

#[derive(Debug, Clone, Serialize)]
pub struct SymbolInfo {
    pub symbol: String,
    pub name: String,
    pub kind: Kind,
    pub sector: String,
}

fn catalog() -> &'static [SymbolInfo] {
    static CATALOG: OnceLock<Vec<SymbolInfo>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let rows: Vec<(String, String, String, String)> =
            serde_json::from_str(include_str!("symbols.json")).expect("symbols.json is valid");
        rows.into_iter()
            .map(|(symbol, name, kind, sector)| SymbolInfo {
                symbol,
                name,
                kind: match kind.as_str() {
                    "etf" => Kind::Etf,
                    "crypto" => Kind::Crypto,
                    _ => Kind::Stock,
                },
                sector,
            })
            .collect()
    })
}

pub fn lookup(symbol: &str) -> Option<&'static SymbolInfo> {
    catalog().iter().find(|s| s.symbol == symbol)
}

/// Matches symbol, name or sector. An empty query lists everything.
pub fn search(query: &str, kind: Option<Kind>) -> Vec<&'static SymbolInfo> {
    let q = query.trim().to_lowercase();
    let mut hits: Vec<(u8, &SymbolInfo)> = catalog()
        .iter()
        .filter(|s| kind.is_none_or(|k| s.kind == k))
        .filter_map(|s| {
            let sym = s.symbol.to_lowercase();
            let rank = if q.is_empty() || sym == q {
                0
            } else if sym.starts_with(&q) {
                1
            } else if s.name.to_lowercase().contains(&q) {
                2
            } else if s.sector.to_lowercase().contains(&q) {
                3
            } else {
                return None;
            };
            Some((rank, s))
        })
        .collect();
    hits.sort_by_key(|(rank, _)| *rank);
    hits.into_iter().map(|(_, s)| s).collect()
}
