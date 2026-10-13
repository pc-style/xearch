//! Work budgets for watcher passes, in bytes read and written: exact where
//! timings on a shared CI runner are not, and they grow with the same
//! mistakes. In October 2026 a pass rewrote the 2 MB registry once per
//! file in the drop directory, 10,000 times a pass; the indexer sat at full
//! CPU for hours and new posts waited behind it. These fail long before
//! that reaches production.
#![cfg(target_os = "linux")]

mod support;

use search_indexer::{run_once, users::registry_path};
use support::{capture, capture_name, imported_root, thread_io};

/// As many captures as production held when this was written, roughly.
const CAPTURES: u64 = 4000;

fn registry_bytes(config: &search_indexer::Config) -> support::Result<u64> {
    Ok(std::fs::metadata(registry_path(&config.state_dir))?.len())
}

#[test]
fn a_pass_with_nothing_new_reads_the_registry_once_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let config = imported_root(dir.path(), CAPTURES).unwrap();
    let registry = registry_bytes(&config).unwrap();

    let (read_before, written_before) = thread_io().unwrap();
    run_once(&config).unwrap();
    let (read_after, written_after) = thread_io().unwrap();

    let written = written_after - written_before;
    let read = read_after - read_before;
    assert!(written < 64 * 1024, "an idle pass wrote {written} bytes");
    assert!(
        read < 2 * registry + 1024 * 1024,
        "an idle pass read {read} bytes for a {registry}-byte registry"
    );
}

#[test]
fn importing_one_capture_costs_the_same_however_many_came_before() {
    let dir = tempfile::tempdir().unwrap();
    let config = imported_root(dir.path(), CAPTURES).unwrap();
    std::fs::write(
        config.drop_dir.join(capture_name(CAPTURES)),
        capture(10_000, 20),
    )
    .unwrap();
    let registry = registry_bytes(&config).unwrap();

    let (read_before, written_before) = thread_io().unwrap();
    let after = run_once(&config).unwrap();
    let (read_after, written_after) = thread_io().unwrap();

    assert_eq!(after.captures.len(), usize::try_from(CAPTURES + 1).unwrap());
    // The registry saved after the import and at the end of the pass, plus
    // the capture retained in the archive: never once per stored capture.
    let written = written_after - written_before;
    assert!(
        written < 3 * registry + 1024 * 1024,
        "importing one capture wrote {written} bytes for a {registry}-byte registry"
    );
    let read = read_after - read_before;
    assert!(
        read < 3 * registry + 4 * 1024 * 1024,
        "importing one capture read {read} bytes for a {registry}-byte registry"
    );
}
