//! The indexer's own costs, for the performance workflow
//! (scripts/bench/measure.mjs compares them between a pull request and its
//! base): a watcher pass with nothing new, a pass importing one capture
//! into a data root shaped like production's, and a rebuild from the
//! archive. `tests/work.rs` holds the same passes to exact byte budgets.
use criterion::{BatchSize, Criterion};
use std::hint::black_box;
#[path = "../tests/support/mod.rs"]
mod support;

const CAPTURES: u64 = 4000;

fn main() -> support::Result<()> {
    let idle_dir = tempfile::tempdir()?;
    let idle = support::imported_root(idle_dir.path(), CAPTURES)?;
    let busy_dir = tempfile::tempdir()?;
    let busy = support::imported_root(busy_dir.path(), CAPTURES)?;
    let archived_dir = tempfile::tempdir()?;
    let archived = support::archived_root(archived_dir.path(), 300, 20)?;
    let engine = search_tantivy::open(&archived.index, false)?;
    let mut next = CAPTURES;
    let mut failure = None;

    let mut c = Criterion::default().configure_from_args();
    {
        let mut group = c.benchmark_group("indexer");
        group.sample_size(10);
        group.bench_function("idle pass, 4000 captures", |b| {
            b.iter(|| {
                if let Err(error) = black_box(search_indexer::run_once(&idle)) {
                    failure = Some(error);
                }
            });
        });
        group.bench_function("import one capture, 4000 captures", |b| {
            b.iter_batched(
                || {
                    next = next.saturating_add(1);
                    std::fs::write(
                        busy.drop_dir.join(support::capture_name(next)),
                        support::capture(next.saturating_mul(100), 20),
                    )
                },
                |written| {
                    if let Err(error) = written
                        .map_err(|error| search_model::Error::Storage(error.to_string()))
                        .and_then(|()| search_indexer::run_once(&busy))
                    {
                        failure = Some(error);
                    }
                },
                BatchSize::PerIteration,
            );
        });
        group.bench_function("rebuild, 6000 posts", |b| {
            b.iter(|| {
                if let Err(error) =
                    black_box(search_indexer::rebuild::rebuild(&archived.archive, &engine))
                {
                    failure = Some(error);
                }
            });
        });
        group.finish();
    }
    c.final_summary();
    drop(c);
    failure.map_or(Ok(()), |error| Err(error.into()))
}
