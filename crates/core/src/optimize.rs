//! Grid search over strategy parameters, ranked on a training period and reported alongside a
//! validation period the ranking never saw.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::backtest::{self, BacktestConfig};
use crate::bar::DAY;
use crate::eval::Market;
use crate::metrics::Metrics;
use crate::strategy::{self, Strategy};
use crate::validate;

pub const MAX_COMBINATIONS: usize = 500;

#[derive(Debug, Clone, Deserialize)]
pub struct Param {
    /// Either a JSON pointer (`/rules/0/when/lt/1`) or the path style validation reports
    /// (`rules[0].when.lt[1]`).
    pub path: String,
    pub values: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OptimizeSpec {
    pub params: Vec<Param>,
    #[serde(default = "default_train")]
    pub train_fraction: f64,
    #[serde(default)]
    pub objective: Objective,
    #[serde(default = "default_top")]
    pub top: usize,
}

fn default_train() -> f64 {
    0.7
}
fn default_top() -> usize {
    5
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Objective {
    #[default]
    Sharpe,
    Return,
    Calmar,
}

impl Objective {
    fn score(self, m: &Metrics) -> f64 {
        match self {
            Objective::Sharpe => m.sharpe,
            Objective::Return => m.total_return_pct,
            Objective::Calmar => m.calmar,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub values: Vec<Value>,
    pub strategy: Strategy,
    pub train: Metrics,
    pub validation: Metrics,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptimizeResult {
    pub objective: Objective,
    pub combinations: usize,
    pub invalid: usize,
    pub train_period: (i64, i64),
    pub validation_period: (i64, i64),
    /// The strategy as given.
    pub baseline: Candidate,
    /// Best on the training period, best first.
    pub best: Vec<Candidate>,
}

pub fn optimize(
    s: &Strategy,
    market: &Market,
    cfg: &BacktestConfig,
    spec: &OptimizeSpec,
) -> Result<OptimizeResult, String> {
    if spec.params.is_empty() {
        return Err("give at least one parameter to vary".into());
    }
    if !(0.3..=0.9).contains(&spec.train_fraction) {
        return Err("train_fraction must be between 0.3 and 0.9".into());
    }
    let base = serde_json::to_value(s).map_err(|e| e.to_string())?;
    let pointers: Vec<String> = spec.params.iter().map(|p| to_pointer(&p.path)).collect();
    for (p, ptr) in spec.params.iter().zip(&pointers) {
        if base.pointer(ptr).is_none() {
            return Err(format!(
                "{} doesn't point at anything in the strategy",
                p.path
            ));
        }
        if p.values.is_empty() {
            return Err(format!("{} has no values to try", p.path));
        }
    }
    let combinations: usize = spec.params.iter().map(|p| p.values.len()).product();
    if combinations > MAX_COMBINATIONS {
        return Err(format!(
            "{combinations} combinations is too many; keep it under {MAX_COMBINATIONS}"
        ));
    }

    let split = cfg.start + ((cfg.end - cfg.start) as f64 * spec.train_fraction) as i64 / DAY * DAY;
    let train_cfg = BacktestConfig {
        end: split,
        ..cfg.clone()
    };
    let validation_cfg = BacktestConfig {
        start: split + DAY,
        ..cfg.clone()
    };
    let evaluate = |strategy: Strategy, values: Vec<Value>| -> Option<Candidate> {
        let train = backtest::run(&strategy, market, &train_cfg).ok()?.metrics;
        let validation = backtest::run(&strategy, market, &validation_cfg)
            .ok()?
            .metrics;
        Some(Candidate {
            values,
            strategy,
            train,
            validation,
        })
    };

    let baseline = evaluate(
        s.clone(),
        pointers
            .iter()
            .map(|p| base.pointer(p).unwrap().clone())
            .collect(),
    )
    .ok_or("the strategy doesn't run on this period")?;

    let grid: Vec<Vec<Value>> = (0..combinations)
        .map(|mut i| {
            spec.params
                .iter()
                .map(|p| {
                    let v = p.values[i % p.values.len()].clone();
                    i /= p.values.len();
                    v
                })
                .collect()
        })
        .collect();

    let results: Vec<Option<Candidate>> = grid
        .into_par_iter()
        .map(|values| {
            let mut doc = base.clone();
            for (ptr, v) in pointers.iter().zip(&values) {
                *doc.pointer_mut(ptr)? = v.clone();
            }
            let strategy = strategy::parse(doc).ok()?;
            if validate::has_errors(&validate::validate(&strategy)) {
                return None;
            }
            evaluate(strategy, values)
        })
        .collect();

    let invalid = results.iter().filter(|r| r.is_none()).count();
    let mut best: Vec<Candidate> = results.into_iter().flatten().collect();
    best.sort_by(|a, b| {
        spec.objective
            .score(&b.train)
            .total_cmp(&spec.objective.score(&a.train))
    });
    best.truncate(spec.top.clamp(1, 20));

    Ok(OptimizeResult {
        objective: spec.objective,
        combinations,
        invalid,
        train_period: (cfg.start, split),
        validation_period: (split + DAY, cfg.end),
        baseline,
        best,
    })
}

/// `rules[0].when.all[1].lt[0].rsi.period` → `/rules/0/when/all/1/lt/0/rsi/period`.
pub fn to_pointer(path: &str) -> String {
    if path.starts_with('/') {
        return path.to_string();
    }
    let mut out = String::new();
    for part in path.split('.') {
        let mut rest = part;
        if let Some(i) = rest.find('[') {
            out.push('/');
            out.push_str(&rest[..i]);
            rest = &rest[i..];
        } else {
            out.push('/');
            out.push_str(rest);
            continue;
        }
        for idx in rest.split('[').filter(|s| !s.is_empty()) {
            out.push('/');
            out.push_str(idx.trim_end_matches(']'));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_paths_to_pointers() {
        assert_eq!(
            to_pointer("rules[0].when.all[1].lt[0].rsi.period"),
            "/rules/0/when/all/1/lt/0/rsi/period"
        );
        assert_eq!(to_pointer("risk.stop_loss_pct"), "/risk/stop_loss_pct");
        assert_eq!(to_pointer("/rules/0"), "/rules/0");
    }
}
